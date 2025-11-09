const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const OFFSCREEN_REASON = "AUDIO_CAPTURE";
let captureState = {
  tabId: null,
  streamId: null,
  backendUrl: null,
  meetingId: null
};

async function ensureOffscreenDocument() {
  const offscreenDocs = await chrome.offscreen.hasDocument?.();
  if (offscreenDocs) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [OFFSCREEN_REASON],
    justification: "Capture Google Meet audio and relay chunks to backend."
  });
}

async function startCapture(tabId, backendUrl) {
  if (captureState.streamId) {
    return captureState;
  }
  await ensureOffscreenDocument();
  const meetingId = crypto.randomUUID();
  const tabStreamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tabId
  });
  captureState = { tabId, streamId: tabStreamId, backendUrl, meetingId };
  await chrome.runtime.sendMessage({
    type: "meeting-capture-start",
    streamId: tabStreamId,
    backendUrl,
    meetingId
  });
  return captureState;
}

async function stopCapture() {
  if (!captureState.streamId) return;
  await chrome.runtime.sendMessage({
    type: "meeting-capture-stop",
    meetingId: captureState.meetingId
  });
  captureState = { tabId: null, streamId: null, backendUrl: null, meetingId: null };
  if (chrome.offscreen?.hasDocument) {
    const exists = await chrome.offscreen.hasDocument();
    if (exists) {
      await chrome.offscreen.closeDocument();
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "start-meeting-capture") {
      const tabId = message.tabId ?? sender.tab?.id;
      const state = await startCapture(tabId, message.backendUrl);
      sendResponse({ ok: true, state });
      return;
    }
    if (message?.type === "stop-meeting-capture") {
      await stopCapture();
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "transcript-patch") {
      // Broadcast transcript updates to popup/action UI.
      await chrome.runtime.sendMessage({
        type: "transcript-patch",
        payload: message.payload
      });
      sendResponse({ ok: true });
      return;
    }
    if (message?.type === "speaker-update") {
      const snapshot = {
        ...message.payload,
        meetingId: captureState.meetingId ?? null
      };
      await chrome.runtime.sendMessage({
        type: "speaker-update",
        payload: message.payload
      });
      if (captureState.meetingId) {
        await chrome.runtime.sendMessage({
          type: "meeting-speaker-snapshot",
          payload: snapshot
        });
      }
      sendResponse({ ok: true });
      return;
    }
  })();
  return true;
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  if (captureState.streamId) {
    await stopCapture();
    return;
  }
  await startCapture(tab.id, null);
});
