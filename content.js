/**
 * content.js — Injected into every page.
 * Extracts page signals and sends them to the background service worker for analysis.
 */

const ANALYSIS_DEBOUNCE_MS = 2000;
let analysisTimer = null;

// ── Page Signal Extraction ────────────────────────────────────────────────────

function extractPageSignals() {
  const url = window.location.href;
  const title = document.title;

  // Forms: flag presence of password / credit card fields
  const forms = Array.from(document.querySelectorAll("form")).map((form) => ({
    action: form.action || "",
    hasPasswordField: form.querySelector('input[type="password"]') !== null,
    hasEmailField: form.querySelector('input[type="email"]') !== null,
    hasCardField:
      form.querySelector('input[autocomplete*="cc"]') !== null ||
      /card|cvv|cvc|expir/i.test(form.innerHTML),
    inputCount: form.querySelectorAll("input").length,
  }));

  // External links — count links pointing away from the current domain
  const currentHost = window.location.hostname;
  const links = Array.from(document.querySelectorAll("a[href]"));
  const externalLinks = links
    .filter((a) => {
      try {
        return new URL(a.href).hostname !== currentHost;
      } catch {
        return false;
      }
    })
    .slice(0, 20)
    .map((a) => a.href);

  // Visible text — grab a representative excerpt (first 2000 chars)
  const bodyText = (document.body?.innerText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);

  // Meta tags (og:url, description, etc.)
  const metaTags = {};
  document.querySelectorAll("meta[name], meta[property]").forEach((m) => {
    const key = m.getAttribute("name") || m.getAttribute("property");
    if (key) metaTags[key] = m.getAttribute("content") || "";
  });

  // Suspicious DOM signals
  const hasLoginForm = forms.some(
    (f) => f.hasPasswordField || f.hasEmailField
  );
  const hasFavicon = document.querySelector('link[rel*="icon"]') !== null;
  const iframeCount = document.querySelectorAll("iframe").length;
  const hiddenInputCount = document.querySelectorAll(
    'input[type="hidden"]'
  ).length;

  return {
    url,
    title,
    forms,
    externalLinks,
    bodyText,
    metaTags,
    hasLoginForm,
    hasFavicon,
    iframeCount,
    hiddenInputCount,
    linkCount: links.length,
    externalLinkCount: externalLinks.length,
  };
}

// ── Element Highlighting ──────────────────────────────────────────────────────

let highlightsActive = false;
let cachedHighlightElements = null;

function injectHighlightStyles() {
  if (document.getElementById("phishguard-highlight-style")) return;
  const style = document.createElement("style");
  style.id = "phishguard-highlight-style";
  style.textContent = `
    .phishguard-suspicious,
    .phishguard-ai-highlight {
      outline: 3px solid #f59e0b !important;
      outline-offset: 3px;
    }
    .phishguard-highlight-label {
      display: inline-block;
      background: #f59e0b;
      color: #000;
      font-size: 11px;
      font-family: system-ui, sans-serif;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 3px;
      margin: 4px 0 2px;
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
}

function applyHighlights(elements) {
  injectHighlightStyles();
  elements.forEach(({ selector, reason }) => {
    let targets;
    try {
      targets = document.querySelectorAll(selector);
    } catch {
      return; // bad selector from LLM — skip
    }
    targets.forEach((el) => {
      el.classList.add("phishguard-suspicious");
      const label = document.createElement("div");
      label.className = "phishguard-highlight-label phishguard-injected";
      label.textContent = `⚠ ${reason}`;
      el.insertAdjacentElement("beforebegin", label);
    });
  });
}

function removeHighlights() {
  document.querySelectorAll(".phishguard-suspicious").forEach((el) =>
    el.classList.remove("phishguard-suspicious")
  );
  document.querySelectorAll(".phishguard-injected").forEach((el) => el.remove());
}

async function toggleHighlights() {
  if (highlightsActive) {
    removeHighlights();
    highlightsActive = false;
    return;
  }

  if (cachedHighlightElements) {
    applyHighlights(cachedHighlightElements);
    highlightsActive = true;
    return;
  }

  // Ask the LLM to identify suspicious elements
  const signals = extractPageSignals();
  const stored = await chrome.storage.local.get(`result:${signals.url}`);
  const result = stored[`result:${signals.url}`];
  if (!result?.isPhishing) return;

  const response = await chrome.runtime.sendMessage({
    type: "HIGHLIGHT_REQUEST",
    payload: { signals, reason: result.reason },
  });

  if (response?.elements?.length) {
    cachedHighlightElements = response.elements;
    applyHighlights(response.elements);
    highlightsActive = true;
  }
}

// ── AI DOM Actions ────────────────────────────────────────────────────────────

let aiInjected = [];   // labels / badges added by AI
let aiHidden = [];     // elements hidden by AI

function clearAiActions() {
  aiInjected.forEach((el) => el.remove());
  aiInjected = [];
  aiHidden.forEach((el) => { el.style.display = ""; });
  aiHidden = [];
  document.querySelectorAll(".phishguard-ai-highlight").forEach((el) =>
    el.classList.remove("phishguard-ai-highlight")
  );
}

function applyDomActions(actions) {
  clearAiActions();
  injectHighlightStyles();

  let firstTarget = null;

  actions.forEach(({ type, selector, label }) => {
    let targets;
    try { targets = document.querySelectorAll(selector); } catch { return; }

    targets.forEach((el) => {
      if (type === "highlight") {
        el.classList.add("phishguard-ai-highlight");
        if (label) {
          const badge = document.createElement("div");
          badge.className = "phishguard-highlight-label phishguard-injected";
          badge.textContent = `⚠ ${label}`;
          el.insertAdjacentElement("beforebegin", badge);
          aiInjected.push(badge);
        }
        if (!firstTarget) firstTarget = el;
      } else if (type === "annotate") {
        const badge = document.createElement("div");
        badge.className = "phishguard-highlight-label phishguard-injected";
        badge.style.cssText = "background:#3b82f6;color:#fff;";
        badge.textContent = `ℹ ${label}`;
        el.insertAdjacentElement("afterend", badge);
        aiInjected.push(badge);
        if (!firstTarget) firstTarget = el;
      } else if (type === "hide") {
        el.style.display = "none";
        aiHidden.push(el);
      }
    });
  });

  if (firstTarget) {
    firstTarget.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "TOGGLE_HIGHLIGHTS") toggleHighlights();
  if (message.type === "DOM_ACTIONS") applyDomActions(message.payload);
});

// ── Warning Banner ────────────────────────────────────────────────────────────

function showWarningBanner(result) {
  if (document.getElementById("phishguard-banner")) return;

  const banner = document.createElement("div");
  banner.id = "phishguard-banner";
  banner.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 2147483647;
    background: #b91c1c;
    color: #fff;
    font-family: system-ui, sans-serif;
    font-size: 14px;
    padding: 10px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-shadow: 0 2px 8px rgba(0,0,0,0.4);
  `;

  const btnStyle = `
    border: 1px solid rgba(255,255,255,0.6);
    color: #fff;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
  `;

  banner.innerHTML = `
    <span>
      ⚠️ <strong>GonePhishin Warning:</strong> This page may be a phishing attempt.
      <em style="opacity:0.9;">${result.reason}</em>
    </span>
    <span style="display:flex;gap:8px;flex-shrink:0;margin-left:12px;">
      <button id="phishguard-highlight" style="background:rgba(255,255,255,0.15);${btnStyle}">Highlight suspicious</button>
      <button id="phishguard-learn" style="background:rgba(255,255,255,0.15);${btnStyle}">Learn more</button>
      <button id="phishguard-dismiss" style="background:transparent;${btnStyle}">Dismiss</button>
    </span>
  `;

  document.body.prepend(banner);
  document.getElementById("phishguard-dismiss").addEventListener("click", () =>
    banner.remove()
  );
  document.getElementById("phishguard-learn").addEventListener("click", openChat);
  document.getElementById("phishguard-highlight").addEventListener("click", async function () {
    await toggleHighlights();
    this.textContent = highlightsActive ? "Remove highlights" : "Highlight suspicious";
  });
}

function removeWarningBanner() {
  document.getElementById("phishguard-banner")?.remove();
}

function openChat() {
  chrome.runtime.sendMessage({ type: "OPEN_CHAT" });
}

// ── Analysis Trigger ──────────────────────────────────────────────────────────

function scheduleAnalysis() {
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(runAnalysis, ANALYSIS_DEBOUNCE_MS);
}

async function runAnalysis(forceRefresh = false) {
  const signals = extractPageSignals();
  if (forceRefresh) signals.forceRefresh = true;

  // Skip trivial pages (new tab, extension pages, local files)
  if (
    !signals.url.startsWith("http://") &&
    !signals.url.startsWith("https://")
  ) {
    return;
  }

  try {
    const result = await chrome.runtime.sendMessage({
      type: "ANALYZE_PAGE",
      payload: signals,
    });

    if (!result) return;

    if (result.isPhishing) {
      // Save context for the chat page
      chrome.storage.local.set({ [`chatContext:${signals.url}`]: { ...signals, ...result } });

      const { detectionMode, showReason } = await chrome.storage.sync.get(["detectionMode", "showReason"]);
      const mode = detectionMode || "passive1";
      const includeReason = showReason !== false;
      const warningText = includeReason ? result.reason : "Phishing detected.";

      if (mode === "passive1") {
        showWarningBanner({ ...result, reason: warningText });
      } else if (mode === "passive2") {
        alert(`⚠️ GonePhishin: Phishing Detected\n\n${warningText}`);
      }
      // mode === "manual": do nothing, popup shows the result
    } else {
      removeWarningBanner();
    }

    // Persist result so popup can display it
    chrome.storage.local.set({
      [`result:${signals.url}`]: {
        ...result,
        analyzedAt: Date.now(),
      },
    });
  } catch (err) {
    // Background may not be ready yet; silently ignore
    console.debug("[GonePhishin] Analysis skipped:", err.message);
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

// Listen for re-analyze requests from the popup
window.addEventListener("phishguard:reanalyze", () => {
  clearTimeout(analysisTimer);
  runAnalysis(true); // forceRefresh = true
});

scheduleAnalysis();

// Re-analyze on significant DOM mutations (SPAs that change content without navigation)
const observer = new MutationObserver(() => scheduleAnalysis());
observer.observe(document.body, { childList: true, subtree: false });
