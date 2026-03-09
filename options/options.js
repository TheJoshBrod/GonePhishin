/**
 * options.js — Saves and loads user settings from chrome.storage.sync.
 */

const apiKeyInput = document.getElementById("api-key");
const saveBtn = document.getElementById("save-btn");
const saveStatus = document.getElementById("save-status");
const showBannerToggle = document.getElementById("show-banner");
const analyzeAllToggle = document.getElementById("analyze-all");

// ── Load existing settings ────────────────────────────────────────────────────

chrome.storage.sync.get(["apiKey", "showBanner", "analyzeAll"], (data) => {
  if (data.apiKey) {
    // Show masked placeholder so the user knows a key exists
    apiKeyInput.placeholder = "sk-ant-••••••••••••••••";
  }
  showBannerToggle.checked = data.showBanner !== false; // default true
  analyzeAllToggle.checked = data.analyzeAll !== false; // default true
});

// ── Save ──────────────────────────────────────────────────────────────────────

saveBtn.addEventListener("click", () => {
  const settings = {
    showBanner: showBannerToggle.checked,
    analyzeAll: analyzeAllToggle.checked,
  };

  // Only update apiKey if the user actually typed something
  const keyValue = apiKeyInput.value.trim();
  if (keyValue) {
    settings.apiKey = keyValue;
  }

  chrome.storage.sync.set(settings, () => {
    apiKeyInput.value = "";
    apiKeyInput.placeholder = "sk-ant-••••••••••••••••";

    saveStatus.classList.add("visible");
    setTimeout(() => saveStatus.classList.remove("visible"), 2000);
  });
});
