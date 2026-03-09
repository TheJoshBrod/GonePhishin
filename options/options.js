/**
 * options.js — Saves and loads user settings from chrome.storage.sync.
 * Each section has its own independent Save button.
 */

const apiKeyInput     = document.getElementById("api-key");
const saveKeyBtn      = document.getElementById("save-key-btn");
const keySaved        = document.getElementById("key-saved");

const modeRadios      = document.querySelectorAll('input[name="mode"]');
const saveModeBtn     = document.getElementById("save-mode-btn");
const modeSaved       = document.getElementById("mode-saved");

const analyzeAllToggle   = document.getElementById("analyze-all");
const showReasonToggle   = document.getElementById("show-reason");
const saveBehaviorBtn    = document.getElementById("save-behavior-btn");
const behaviorSaved      = document.getElementById("behavior-saved");

// ── Helpers ───────────────────────────────────────────────────────────────────

function flash(el) {
  el.classList.add("visible");
  setTimeout(() => el.classList.remove("visible"), 2000);
}

// ── Load ──────────────────────────────────────────────────────────────────────

chrome.storage.sync.get(["apiKey", "detectionMode", "analyzeAll", "showReason"], (data) => {
  if (data.apiKey) {
    apiKeyInput.placeholder = "AIza••••••••••••••••";
  }

  const mode = data.detectionMode || "passive1";
  modeRadios.forEach((r) => { if (r.value === mode) r.checked = true; });

  analyzeAllToggle.checked = data.analyzeAll !== false;
  showReasonToggle.checked = data.showReason !== false; // default true
});

// ── Save: API Key ─────────────────────────────────────────────────────────────

saveKeyBtn.addEventListener("click", () => {
  const keyValue = apiKeyInput.value.trim();
  if (!keyValue) return;

  chrome.storage.sync.set({ apiKey: keyValue }, () => {
    apiKeyInput.value = "";
    apiKeyInput.placeholder = "AIza••••••••••••••••";
    flash(keySaved);
  });
});

// ── Save: Detection Mode ──────────────────────────────────────────────────────

saveModeBtn.addEventListener("click", () => {
  const selected = [...modeRadios].find((r) => r.checked)?.value ?? "passive1";
  chrome.storage.sync.set({ detectionMode: selected }, () => flash(modeSaved));
});

// ── Save: Behavior ────────────────────────────────────────────────────────────

saveBehaviorBtn.addEventListener("click", () => {
  chrome.storage.sync.set({
    analyzeAll: analyzeAllToggle.checked,
    showReason: showReasonToggle.checked,
  }, () => flash(behaviorSaved));
});
