const SPEAKER_SELECTOR_CANDIDATES = [
  '[data-self-name].kBPcHd',
  '[data-requested-participant-id] div[aria-live="polite"]',
  '[role="listitem"][data-sorted-index] div[aria-live="assertive"]'
];

function getActiveSpeakers() {
  const results = [];
  SPEAKER_SELECTOR_CANDIDATES.forEach((selector) => {
    document.querySelectorAll(selector).forEach((el) => {
      const text = el.textContent?.trim();
      if (text && !results.includes(text)) {
        results.push(text);
      }
    });
  });
  return results.slice(0, 3);
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
