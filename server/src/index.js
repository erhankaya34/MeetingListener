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
  const params = new URLSearchParams(request.url.replace("/stream?", ""));
  const meetingId = params.get("meetingId") || crypto.randomUUID();
  const session = new MeetingSession({ socket, meetingId, openai });
  socket.on("message", (data) => session.pushAudio(data));
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
  }

  async pushAudio(chunk) {
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
        const segments = (transcription.segments ?? []).map((segment) => ({
          speaker: null,
          text: segment.text.trim(),
          start: segment.start,
          end: segment.end
        }));
        await this.handleTranscriptPatch({
          type: "append",
          segments
        });
        console.log(`Transcribed ${segments.length} segments for meeting ${this.meetingId} in ${Date.now() - startedAt}ms`);
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
          tasks: summary.tasks ?? []
        };
        this.lastSummaryAt = Date.now();
      }
    }
    this.broadcast({ type: "transcript-patch", payload });
  }

  async generateSummary() {
    if (!this.bufferedSegments.length) return this.lastSummary;
    const prompt = [
      "Aşağıdaki transcript bloklarına göre toplantı özetini ve aksiyon maddelerini çıkar.",
      "JSON döndür:",
      "{ \"summary\": \"...\", \"tasks\": [{\"owner\": \"\", \"text\": \"\"}] }",
      "",
      this.bufferedSegments.map((segment) => `${segment.speaker ?? "?"}: ${segment.text}`).join("\n")
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
