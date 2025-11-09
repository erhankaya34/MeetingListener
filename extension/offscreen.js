let mediaRecorder;
let backendStreamer;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "meeting-capture-start") {
    startPipeline(message.streamId, message.backendUrl).then(() => {
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
});

async function startPipeline(streamId, backendUrl) {
  if (mediaRecorder) return;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    }
  });

  backendStreamer = new BackendStreamer(backendUrl);
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
  if (backendStreamer) {
    await backendStreamer.close();
    backendStreamer = undefined;
  }
}

class BackendStreamer {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.socket = null;
  }

  async connect() {
    if (!this.endpoint) {
      console.warn("Backend URL missing, audio will be dropped.");
      return;
    }
    this.socket = new WebSocket(this.endpoint);
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
}
