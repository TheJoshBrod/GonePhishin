/**
 * popup.js — Renders the current page's analysis result.
 */

const card = document.getElementById("status-card");
const icon = document.getElementById("status-icon");
const label = document.getElementById("status-label");
const reason = document.getElementById("status-reason");
const badge = document.getElementById("confidence-badge");
const timestamp = document.getElementById("analyzed-at");
const reanalyzeBtn = document.getElementById("reanalyze-btn");
const optionsLink = document.getElementById("options-link");
const learnMoreBtn = document.getElementById("learn-more-btn");

optionsLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

learnMoreBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("chat/chat.html") });
});

reanalyzeBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  // Clear cached result and re-inject the content script trigger
  await chrome.storage.local.remove(`result:${tab.url}`);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      // Signal content.js to run analysis immediately
      window.dispatchEvent(new CustomEvent("phishguard:reanalyze"));
    },
  });

  setLoading();
  // Poll for new result
  pollForResult(tab.url);
});

function setLoading() {
  card.className = "card";
  icon.textContent = "⏳";
  label.textContent = "Analyzing...";
  reason.textContent = "";
  badge.className = "badge hidden";
  timestamp.textContent = "";
}

function renderResult(result) {
  if (!result) {
    card.className = "card unknown";
    icon.textContent = "❓";
    label.textContent = "No result yet";
    reason.textContent = "Visit a page to trigger analysis.";
    return;
  }

  if (result.error) {
    card.className = "card unknown";
    icon.textContent = "⚠️";
    label.textContent = "Error";
    reason.textContent = result.error;
    return;
  }

  if (result.isPhishing) {
    card.className = "card phishing";
    icon.textContent = "🚨";
    label.textContent = "Phishing Detected";
    learnMoreBtn.classList.remove("hidden");
  } else {
    card.className = "card safe";
    icon.textContent = "✅";
    label.textContent = "Page Appears Safe";
  }

  reason.textContent = result.reason || "";

  if (result.confidence) {
    badge.textContent = `${result.confidence} confidence`;
    badge.className = `badge ${result.confidence}`;
  }

  if (result.analyzedAt) {
    const elapsed = Math.round((Date.now() - result.analyzedAt) / 1000);
    timestamp.textContent =
      elapsed < 60 ? `${elapsed}s ago` : `${Math.round(elapsed / 60)}m ago`;
  }
}

async function loadResult(url) {
  const stored = await chrome.storage.local.get(`result:${url}`);
  return stored[`result:${url}`] ?? null;
}

function pollForResult(url, attempts = 0) {
  if (attempts > 60) return; // Give up after ~30s
  setTimeout(async () => {
    const result = await loadResult(url);
    if (result) {
      renderResult(result);
    } else {
      pollForResult(url, attempts + 1);
    }
  }, 500);
}

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) {
    renderResult(null);
    return;
  }

  const result = await loadResult(tab.url);
  if (result) {
    renderResult(result);
  } else {
    setLoading();
    pollForResult(tab.url);
  }
})();
