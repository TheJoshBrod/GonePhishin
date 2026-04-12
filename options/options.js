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

const claudeKeyInput     = document.getElementById("claude-key");
const useClaudeToggle    = document.getElementById("use-claude");
const saveClaudeBtn      = document.getElementById("save-claude-btn");
const claudeSaved        = document.getElementById("claude-saved");

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

chrome.storage.sync.get(["apiKey", "claudeApiKey", "useClaude", "detectionMode", "analyzeAll", "showReason"], (data) => {
  if (data.claudeApiKey) claudeKeyInput.placeholder = "sk-ant-••••••••••••••••";
  useClaudeToggle.checked = data.useClaude === true;

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

// ── Save: Claude Fallback ─────────────────────────────────────────────────────

saveClaudeBtn.addEventListener("click", () => {
  const updates = { useClaude: useClaudeToggle.checked };
  const keyValue = claudeKeyInput.value.trim();
  if (keyValue) {
    updates.claudeApiKey = keyValue;
  }
  chrome.storage.sync.set(updates, () => {
    if (keyValue) {
      claudeKeyInput.value = "";
      claudeKeyInput.placeholder = "sk-ant-••••••••••••••••";
    }
    flash(claudeSaved);
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

// ── Whitelist ─────────────────────────────────────────────────────────────────

const DEFAULT_WHITELIST = [
  "google.com", "youtube.com", "gmail.com", "github.com", "stackoverflow.com",
  "amazon.com", "apple.com", "microsoft.com", "linkedin.com", "reddit.com",
  "wikipedia.org", "netflix.com", "twitter.com", "x.com", "facebook.com",
  "instagram.com", "whatsapp.com", "zoom.us", "slack.com", "notion.so",
  "dropbox.com", "icloud.com", "live.com", "outlook.com", "office.com",
  "bing.com", "yahoo.com", "twitch.tv", "spotify.com", "discord.com",
  "stripe.com", "paypal.com", "chase.com", "bankofamerica.com",
  "wellsfargo.com", "nytimes.com", "bbc.com", "cnn.com", "medium.com",
  "cloudflare.com", "aws.amazon.com",
];

const defaultWhitelistEl  = document.getElementById("default-whitelist");
const customWhitelistEl   = document.getElementById("custom-whitelist");
const saveWhitelistBtn    = document.getElementById("save-whitelist-btn");
const whitelistSaved      = document.getElementById("whitelist-saved");

DEFAULT_WHITELIST.forEach((d) => {
  const chip = document.createElement("span");
  chip.className = "chip";
  chip.textContent = d;
  defaultWhitelistEl.appendChild(chip);
});

chrome.storage.sync.get("customWhitelist", (data) => {
  if (Array.isArray(data.customWhitelist) && data.customWhitelist.length) {
    customWhitelistEl.value = data.customWhitelist.join("\n");
  }
});

saveWhitelistBtn.addEventListener("click", () => {
  const domains = customWhitelistEl.value
    .split("\n")
    .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
  chrome.storage.sync.set({ customWhitelist: domains }, () => flash(whitelistSaved));
});
