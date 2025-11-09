import http from "http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import express from "express";
import { WebSocketServer } from "ws";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || 8787;
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, time: Date.now() });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/stream" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TRANSCRIBE_INTERVAL_MS = Number(process.env.TRANSCRIBE_INTERVAL_MS ?? 8000);
const SUMMARY_INTERVAL_MS = Number(process.env.SUMMARY_INTERVAL_MS ?? 60000);
const WHISPER_MODEL = process.env.WHISPER_MODEL || "whisper-1";

wss.on("connection", async (socket, request) => {
  const url = new URL(request.url, "http://localhost");
  const meetingId = url.searchParams.get("meetingId") || crypto.randomUUID();
  const session = new MeetingSession({ socket, meetingId, openai });
  socket.on("message", (data, isBinary) => {
    if (!isBinary) {
      const text = typeof data === "string" ? data : data.toString("utf8");
      session.handleControlMessage(text);
      return;
    }
    session.pushAudio(data);
  });
  socket.on("close", () => {
    session.close().catch((err) => {
      console.error("Failed to cleanly close meeting session", err);
    });
  });
  socket.on("error", (err) => session.handleError(err));
});

server.listen(PORT, () => {
  console.log(`Meeting Listener backend running on :${PORT}`);
});

class MeetingSession {
  constructor({ socket, meetingId, openai }) {
    this.socket = socket;
    this.meetingId = meetingId;
    this.openai = openai;
    this.language = process.env.WHISPER_LANGUAGE || "tr";
    this.bufferedSegments = [];
    this.lastSummary = null;
    this.audioChunks = [];
    this.lastFlushAt = Date.now();
    this.transcribing = false;
    this.lastSummaryAt = 0;
    this.captureStartTimestamp = null;
    this.elapsedAudioMs = 0;
    this.speakerSnapshots = [];
  }

  async pushAudio(chunk) {
    if (!this.captureStartTimestamp) {
      this.captureStartTimestamp = Date.now();
    }
    const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
    this.audioChunks.push(buffer);
    const shouldFlush = Date.now() - this.lastFlushAt >= TRANSCRIBE_INTERVAL_MS;
    if (shouldFlush && !this.transcribing) {
      this.transcribing = true;
      this.flushAudioChunks().catch((err) => {
        console.error("Failed to flush audio chunks", err);
      }).finally(() => {
        this.transcribing = false;
      });
    }
  }

  async flushAudioChunks(force = false) {
    if (!this.audioChunks.length) return;
    if (!force && Date.now() - this.lastFlushAt < TRANSCRIBE_INTERVAL_MS) return;
    const combined = Buffer.concat(this.audioChunks);
    this.audioChunks = [];
    this.lastFlushAt = Date.now();
    const startedAt = Date.now();
    try {
      const { wavPath, cleanup } = await convertWebmBufferToWav(combined);
      try {
        const transcription = await this.openai.audio.transcriptions.create({
          file: fs.createReadStream(wavPath),
          model: WHISPER_MODEL,
          response_format: "verbose_json",
          temperature: 0,
          language: this.language
        });
    const chunkStartMs = this.elapsedAudioMs;
        const maxEnd = Math.max(
          0,
          ...((transcription.segments ?? []).map((segment) => segment.end))
        );
        const chunkDurationMs = Math.max(TRANSCRIBE_INTERVAL_MS, maxEnd * 1000);
        this.elapsedAudioMs += chunkDurationMs;
        const wallClockChunkStart = (this.captureStartTimestamp ?? Date.now()) + chunkStartMs;
        const segments = (transcription.segments ?? []).map((segment) => {
          const absoluteTimestamp = wallClockChunkStart + segment.start * 1000;
          return {
            speaker: this.resolveSpeakerForTimestamp(absoluteTimestamp),
            text: segment.text.trim(),
            start: segment.start,
            end: segment.end
          };
        });
        if (segments.length) {
          await this.handleTranscriptPatch({
            type: "append",
            segments
          });
        }
        console.log(
          `Received ${combined.byteLength} bytes -> ${segments.length} segments for meeting ${this.meetingId} in ${Date.now() - startedAt}ms`
        );
      } finally {
        await cleanup();
      }
    } catch (error) {
      console.error("Transcription failed", error);
    }
  }

  async handleTranscriptPatch(patch) {
    if (patch?.segments?.length) {
      this.bufferedSegments.push(...patch.segments);
    }
    const payload = { ...patch };
    const shouldSummarize = Date.now() - this.lastSummaryAt >= SUMMARY_INTERVAL_MS;
    if (shouldSummarize) {
      const summary = await this.generateSummary().catch((err) => {
        console.error("Summary generation failed", err);
        return null;
      });
      if (summary) {
        payload.summary = {
          text: summary.summary ?? "",
          assignments: summary.assignments ?? []
        };
        this.lastSummaryAt = Date.now();
      }
    }
    this.broadcast({ type: "transcript-patch", payload });
  }

  handleControlMessage(rawMessage) {
    try {
      const message = typeof rawMessage === "string" ? JSON.parse(rawMessage) : rawMessage;
      if (!message) return;
      if (message.type === "speaker-snapshot") {
        this.recordSpeakerSnapshot(message.payload);
      }
    } catch (error) {
      console.error("Failed to handle control message", error);
    }
  }

  recordSpeakerSnapshot(snapshot) {
    if (!snapshot) return;
    const entry = {
      timestamp: snapshot.timestamp ?? Date.now(),
      speakers: Array.isArray(snapshot.speakers) ? snapshot.speakers : []
    };
    this.speakerSnapshots.push(entry);
    const maxSnapshots = 500;
    if (this.speakerSnapshots.length > maxSnapshots) {
      this.speakerSnapshots.splice(0, this.speakerSnapshots.length - maxSnapshots);
    }
  }

  resolveSpeakerForTimestamp(timestamp) {
    if (!timestamp || !this.speakerSnapshots.length) return null;
    const snapshot = [...this.speakerSnapshots].reverse().find((entry) => entry.timestamp <= timestamp);
    return snapshot?.speakers?.[0] ?? null;
  }

  async generateSummary() {
    if (!this.bufferedSegments.length) return this.lastSummary;
    const prompt = [
      "Aşağıdaki transcript blokları bir toplantının ham metnidir.",
      "Görevleri sahiplerine göre grupla ve kısa bir özet çıkar.",
      "Kurallar:",
      "- Cevabı JSON olarak ver.",
      "- Şema: {\"summary\":\"...\",\"assignments\":[{\"owner\":\"Ad Soyad\",\"items\":[{\"text\":\"Görev açıklaması\",\"deadline\":\"Belirtilmedi\"}]}]}",
      "- Eğer görev için tarih/süre belirtilmemişse deadline alanına \"Süre belirtilmedi\" yaz.",
      "- Aynı kişi için birden fazla görev varsa tek \"items\" listesinde hepsini sırala.",
      "- Konuşmacı fikir değiştirip görevi geri aldıysa sadece son geçerli kararı yaz.",
      "- Transcript Türkçe olduğundan tüm çıktı Türkçe olsun.",
      "",
      this.bufferedSegments.map((segment) => `${segment.speaker ?? "Belirsiz"}: ${segment.text}`).join("\n")
    ].join("\n");

    try {
      const completion = await this.openai.responses.create({
        model: process.env.SUMMARY_MODEL || "gpt-4o-mini",
        input: prompt,
        temperature: 0.2,
        response_format: { type: "json_object" }
      });
      const parsed = JSON.parse(completion.output[0].content[0].text);
      this.lastSummary = parsed;
      return parsed;
    } catch (error) {
      console.error("OpenAI summary request failed", error);
      return this.lastSummary;
    }
  }

  broadcast(payload) {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  handleError(error) {
    console.error("Meeting session error", error);
  }

  async close() {
    await this.flushAudioChunks(true).catch((err) => {
      console.error("Failed to flush audio chunks on close", err);
    });
    console.log("Closing meeting session", this.meetingId);
  }
}

async function convertWebmBufferToWav(buffer) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "meetinglistener-"));
  const inputPath = path.join(tmpDir, "chunk.webm");
  const outputPath = path.join(tmpDir, "chunk.wav");
  await writeFile(inputPath, buffer);

  await new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-i",
      inputPath,
      "-ac",
      "1",
      "-ar",
      "16000",
      outputPath
    ]);
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });
  });

  return {
    wavPath: outputPath,
    cleanup: async () => {
      await rm(tmpDir, { recursive: true, force: true });
    }
  };
}
