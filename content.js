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

  banner.innerHTML = `
    <span>
      ⚠️ <strong>PhishGuard Warning:</strong> This page may be a phishing attempt.
      <em style="opacity:0.9;">${result.reason}</em>
    </span>
    <button id="phishguard-dismiss" style="
      background: transparent;
      border: 1px solid rgba(255,255,255,0.6);
      color: #fff;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
      margin-left: 12px;
    ">Dismiss</button>
  `;

  document.body.prepend(banner);
  document.getElementById("phishguard-dismiss").addEventListener("click", () =>
    banner.remove()
  );
}

function removeWarningBanner() {
  document.getElementById("phishguard-banner")?.remove();
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
      showWarningBanner(result);
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
    console.debug("[PhishGuard] Analysis skipped:", err.message);
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
