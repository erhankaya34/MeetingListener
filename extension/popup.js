const DEFAULT_BACKEND_URL = "wss://localhost:8787/stream";

const toggleButton = document.getElementById("toggleCapture");
const speakerListEl = document.getElementById("speakerList");
const transcriptEl = document.getElementById("transcript");
const summaryEl = document.getElementById("summary");
const assignmentsEl = document.getElementById("assignments");
const backendUrlInput = document.getElementById("backendUrl");

let isCapturing = false;
let transcriptBuffer = [];

init();

async function init() {
  const { backendUrl } = await chrome.storage.local.get("backendUrl");
  backendUrlInput.value = backendUrl || DEFAULT_BACKEND_URL;
  if (!backendUrl) {
    await chrome.storage.local.set({ backendUrl: DEFAULT_BACKEND_URL });
  }
  backendUrlInput.addEventListener("input", async (event) => {
    await chrome.storage.local.set({ backendUrl: event.target.value });
  });
  toggleButton.addEventListener("click", onToggleClick);
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "transcript-patch") {
      renderTranscript(message.payload);
    }
    if (message.type === "speaker-update") {
      renderSpeakers(message.payload?.speakers ?? []);
    }
  });
}

async function onToggleClick() {
  toggleButton.disabled = true;
  try {
    if (isCapturing) {
      await chrome.runtime.sendMessage({ type: "stop-meeting-capture" });
      isCapturing = false;
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.runtime.sendMessage({
        type: "start-meeting-capture",
        tabId: tab?.id,
        backendUrl: backendUrlInput.value?.trim() || DEFAULT_BACKEND_URL
      });
      isCapturing = true;
    }
    updateToggleText();
  } catch (error) {
    console.error(error);
  } finally {
    toggleButton.disabled = false;
  }
}

function updateToggleText() {
  toggleButton.textContent = isCapturing ? "Stop Capture" : "Start Capture";
}

function renderSpeakers(speakers) {
  speakerListEl.innerHTML = "";
  speakers.forEach((speaker) => {
    const li = document.createElement("li");
    li.textContent = speaker;
    speakerListEl.appendChild(li);
  });
}

function renderTranscript(payload) {
  if (payload?.type === "append") {
    transcriptBuffer = transcriptBuffer.concat(payload.segments);
  } else if (payload?.type === "replace") {
    transcriptBuffer = payload.segments;
  }
  transcriptEl.textContent = transcriptBuffer.map((segment) => {
    const { speaker, text } = segment;
    return speaker ? `${speaker}: ${text}` : text;
  }).join("\n");
  if (payload?.summary) {
    summaryEl.textContent = payload.summary.text ?? "";
    renderAssignments(payload.summary.assignments ?? []);
  }
}

function renderAssignments(assignments) {
  assignmentsEl.innerHTML = "";
  assignments.forEach((assignment) => {
    const li = document.createElement("li");
    const ownerEl = document.createElement("div");
    ownerEl.className = "assignment-owner";
    ownerEl.textContent = assignment.owner ?? "Konuşmacı";
    li.appendChild(ownerEl);

    const items = Array.isArray(assignment.items) ? assignment.items : [];
    items.forEach((item) => {
      const itemEl = document.createElement("div");
      itemEl.className = "assignment-item";
      const deadlineNote = item.deadline ? ` (${item.deadline})` : " (Süre belirtilmedi)";
      itemEl.textContent = `${item.text}${deadlineNote}`;
      li.appendChild(itemEl);
    });

    assignmentsEl.appendChild(li);
  });
}
