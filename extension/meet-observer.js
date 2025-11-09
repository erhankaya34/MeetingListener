const ACTIVE_SPEAKER_SELECTORS = [
  '[aria-live="polite"] .zWGUib',
  '[role="listitem"][data-sorted-index="0"] .zWGUib',
  '[data-self-name]'
];

const PARTICIPANT_LIST_SELECTOR = '[aria-label*="Katılımcılar"], [aria-label*="Participants"]';

function getActiveSpeakers() {
  const results = new Set();
  ACTIVE_SPEAKER_SELECTORS.forEach((selector) => {
    document.querySelectorAll(selector).forEach((node) => {
      const text = node.textContent?.trim();
      if (text) {
        results.add(text);
      }
    });
  });
  if (!results.size) {
    document.querySelectorAll(`${PARTICIPANT_LIST_SELECTOR} [data-participant-id]`).forEach((node) => {
      const text = node.textContent?.trim();
      if (text) {
        results.add(text);
      }
    });
  }
  return Array.from(results).slice(0, 4);
}

let lastSpeakers = [];

function publishSpeakerState() {
  const speakers = getActiveSpeakers();
  if (JSON.stringify(speakers) === JSON.stringify(lastSpeakers)) {
    return;
  }
  lastSpeakers = speakers;
  chrome.runtime.sendMessage({
    type: "speaker-update",
    payload: {
      speakers,
      timestamp: Date.now()
    }
  }).catch(() => {});
}

const observer = new MutationObserver(() => publishSpeakerState());
observer.observe(document.body, {
  subtree: true,
  childList: true,
  attributes: true
});

publishSpeakerState();
