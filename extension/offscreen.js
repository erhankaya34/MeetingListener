let mediaRecorder;
let backendStreamer;
let currentMeetingId = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "meeting-capture-start") {
    startPipeline(message.streamId, message.backendUrl, message.meetingId).then(() => {
      sendResponse({ ok: true });
    }).catch((err) => {
      console.error("Failed to start pipeline", err);
      sendResponse({ ok: false, error: err?.message });
    });
    return true;
  }
  if (message?.type === "meeting-capture-stop") {
    stopPipeline().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "meeting-speaker-snapshot") {
    backendStreamer?.sendJson({
      type: "speaker-snapshot",
      payload: message.payload
    });
    sendResponse?.({ ok: true });
    return false;
  }
});

async function startPipeline(streamId, backendUrl, meetingId) {
  if (mediaRecorder) return;
  currentMeetingId = meetingId ?? crypto.randomUUID();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    }
  });

  backendStreamer = new BackendStreamer(backendUrl, currentMeetingId);
  await backendStreamer.connect();

  mediaRecorder = new MediaRecorder(stream, {
    mimeType: "audio/webm;codecs=opus",
    bitsPerSecond: 128000
  });

  mediaRecorder.ondataavailable = async (event) => {
    if (!event.data.size) return;
    await backendStreamer.sendAudioChunk(event.data);
  };

  mediaRecorder.start(1500);
}

async function stopPipeline() {
  if (!mediaRecorder) return;
  mediaRecorder.stop();
  mediaRecorder.stream.getTracks().forEach((track) => track.stop());
  mediaRecorder = undefined;
  currentMeetingId = null;
  if (backendStreamer) {
    await backendStreamer.close();
    backendStreamer = undefined;
  }
}

class BackendStreamer {
  constructor(endpoint, meetingId) {
    this.endpoint = endpoint;
    this.meetingId = meetingId;
    this.socket = null;
  }

  async connect() {
    if (!this.endpoint) {
      console.warn("Backend URL missing, audio will be dropped.");
      return;
    }
    const url = new URL(this.endpoint);
    if (this.meetingId) {
      url.searchParams.set("meetingId", this.meetingId);
    }
    this.socket = new WebSocket(url.toString());
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }

  async sendAudioChunk(blob) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const arrayBuffer = await blob.arrayBuffer();
    this.socket.send(arrayBuffer);
  }

  async close() {
    if (!this.socket) return;
    this.socket.close();
  }

  sendJson(data) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(data));
  }
}
