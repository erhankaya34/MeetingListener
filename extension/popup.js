const DEFAULT_BACKEND_URL = "wss://localhost:8787/stream";

const toggleButton = document.getElementById("toggleCapture");
const speakerListEl = document.getElementById("speakerList");
const transcriptEl = document.getElementById("transcript");
const summaryEl = document.getElementById("summary");
const assignmentsEl = document.getElementById("assignments");
const statusEl = document.getElementById("status");

let isCapturing = false;
let transcriptBuffer = [];
let backendUrl = DEFAULT_BACKEND_URL;

init();

async function init() {
  const { backendUrl: storedUrl } = await chrome.storage.local.get("backendUrl");
  backendUrl = storedUrl || DEFAULT_BACKEND_URL;
  toggleButton.addEventListener("click", onToggleClick);
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "transcript-patch") {
      renderTranscript(message.payload);
    }
    if (message.type === "speaker-update") {
      renderSpeakers(message.payload?.speakers ?? []);
    }
  });
  setStatus("Hazır.", "idle");
}

async function onToggleClick() {
  toggleButton.disabled = true;
  try {
    if (isCapturing) {
      await chrome.runtime.sendMessage({ type: "stop-meeting-capture" });
      isCapturing = false;
      setStatus("Dinleme durduruldu.", "idle");
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!isMeetTab(tab)) {
        setStatus("Şu an aktif bir Google Meet sekmesi bulunamadı.", "error");
        return;
      }
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!isMeetTab(tab)) {
        setStatus("Şu an aktif bir Google Meet sekmesi bulunamadı.", "error");
        return;
      }
      await chrome.runtime.sendMessage({
        type: "start-meeting-capture",
        tabId: tab?.id,
        backendUrl
      });
      isCapturing = true;
      setStatus("Dinleme aktif.", "active");
    }
  } catch (error) {
    console.error(error);
    setStatus("Dinleme başlatılamadı. Lütfen yeniden deneyin.", "error");
  } finally {
    toggleButton.disabled = false;
    updateToggleText();
  }
}

function isMeetTab(tab) {
  if (!tab?.url) return false;
  try {
    const url = new URL(tab.url);
    return url.hostname === "meet.google.com";
  } catch (error) {
    return false;
  }
}

function updateToggleText() {
  toggleButton.textContent = isCapturing ? "Dinlemeyi Durdur" : "Dinlemeyi Başlat";
}

function renderSpeakers(speakers) {
  speakerListEl.innerHTML = "";
  if (!speakers.length) {
    const placeholder = document.createElement("li");
    placeholder.className = "muted";
    placeholder.textContent = "Henüz konuşmacı yok.";
    speakerListEl.appendChild(placeholder);
    return;
  }
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

  if (!transcriptBuffer.length) {
    transcriptEl.textContent = "Henüz transcript alınmadı.";
  } else {
    transcriptEl.textContent = transcriptBuffer.map((segment) => {
      const { speaker, text } = segment;
      return speaker ? `${speaker}: ${text}` : text;
    }).join("\n");
  }

  if (payload?.summary) {
    summaryEl.textContent = payload.summary.text ?? "";
    renderAssignments(payload.summary.assignments ?? []);
  }
}

function renderAssignments(assignments) {
  assignmentsEl.innerHTML = "";
  if (!assignments.length) {
    const placeholder = document.createElement("li");
    placeholder.className = "muted";
    placeholder.textContent = "Henüz görev ataması bulunmuyor.";
    assignmentsEl.appendChild(placeholder);
    return;
  }

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

function setStatus(text, tone = "idle") {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}
