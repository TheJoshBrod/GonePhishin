/**
 * popup.js — Main popup view + inline chat view.
 */

// ── Main view elements ────────────────────────────────────────────────────────

const mainView     = document.getElementById("main-view");
const chatView     = document.getElementById("chat-view");
const card         = document.getElementById("status-card");
const icon         = document.getElementById("status-icon");
const label        = document.getElementById("status-label");
const reason       = document.getElementById("status-reason");
const badge        = document.getElementById("confidence-badge");
const timestamp    = document.getElementById("analyzed-at");
const reanalyzeBtn = document.getElementById("reanalyze-btn");
const optionsLink  = document.getElementById("options-link");
const learnMoreBtn = document.getElementById("learn-more-btn");
const highlightBtn = document.getElementById("highlight-btn");

optionsLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

let highlightsOn = false;

highlightBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_HIGHLIGHTS" });
  highlightsOn = !highlightsOn;
  highlightBtn.textContent = highlightsOn
    ? "✖ Remove highlights"
    : "🔍 Highlight suspicious elements";
});

learnMoreBtn.addEventListener("click", openChatView);

reanalyzeBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  await chrome.storage.local.remove(`result:${tab.url}`);
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => window.dispatchEvent(new CustomEvent("phishguard:reanalyze")),
  });

  setLoading();
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
    highlightBtn.classList.remove("hidden");
  } else {
    card.className = "card safe";
    icon.textContent = "✅";
    label.textContent = "Page Appears Safe";
    learnMoreBtn.classList.add("hidden");
    highlightBtn.classList.add("hidden");
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
  if (attempts > 60) return;
  setTimeout(async () => {
    const result = await loadResult(url);
    if (result) {
      renderResult(result);
    } else {
      pollForResult(url, attempts + 1);
    }
  }, 500);
}

// ── Chat view ─────────────────────────────────────────────────────────────────

const chatUrlEl    = document.getElementById("chat-url");
const chatReasonEl = document.getElementById("chat-reason");
const chatMessages = document.getElementById("chat-messages");
const chatInput    = document.getElementById("chat-input");
const chatSendBtn  = document.getElementById("chat-send-btn");
const backBtn      = document.getElementById("back-btn");

let chatHistory = [];
let pageContext = null;
let chatInitializedForUrl = null;

backBtn.addEventListener("click", () => {
  chatView.classList.add("hidden");
  mainView.classList.remove("hidden");
});

document.querySelectorAll(".suggestion-btn").forEach((btn) => {
  btn.addEventListener("click", () => chatSend(btn.dataset.q));
});

chatSendBtn.addEventListener("click", () => chatSend(chatInput.value));

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatSend(chatInput.value);
  }
});

chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = `${chatInput.scrollHeight}px`;
});

async function openChatView() {
  mainView.classList.add("hidden");
  chatView.classList.remove("hidden");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabUrl = tab?.url;

  if (tabUrl !== chatInitializedForUrl) {
    chatMessages.innerHTML = "";
    chatHistory = [];
    pageContext = null;
    await initChat(tabUrl);
    chatInitializedForUrl = tabUrl;
  }
}

async function initChat(tabUrl) {
  const stored = await chrome.storage.local.get([`chatContext:${tabUrl}`, `result:${tabUrl}`]);
  const chatContext = stored[`chatContext:${tabUrl}`];
  const result = stored[`result:${tabUrl}`];

  // Full context preferred; fall back to just the result if the page hasn't been re-analyzed yet
  const ctx = chatContext ?? (result ? { url: tabUrl, reason: result.reason } : null);

  if (!ctx) {
    appendChatMessage("assistant", "No phishing context found for this page. Try re-analyzing it first.");
    return;
  }

  pageContext = ctx;
  chatUrlEl.textContent = pageContext.url;
  chatReasonEl.textContent = pageContext.reason;

  const contextMessage = buildContextMessage(pageContext);
  chatHistory = [
    { role: "user",  parts: [{ text: contextMessage }] },
    { role: "model", parts: [{ text: `Understood. I analyzed this page and flagged it as phishing. Main reason: ${pageContext.reason} — ask me anything.` }] },
  ];

  appendChatMessage("assistant", `I flagged this page as phishing.\n\n**${pageContext.reason}**\n\nAsk me anything using the suggestions above or type your own question.`);
}

function buildContextMessage(ctx) {
  const details = [
    `- URL: ${ctx.url}`,
    ctx.title           ? `- Title: ${ctx.title}` : null,
    ctx.hasLoginForm    != null ? `- Has password/login form: ${ctx.hasLoginForm}` : null,
    ctx.iframeCount     != null ? `- Iframes: ${ctx.iframeCount}` : null,
    ctx.externalLinkCount != null ? `- External links: ${ctx.externalLinkCount} of ${ctx.linkCount} total` : null,
    ctx.bodyText        ? `- Page text snippet: ${ctx.bodyText.slice(0, 400)}` : null,
  ].filter(Boolean).join("\n");

  return `You are a cybersecurity expert helping a user understand why a webpage was flagged as phishing.

Page details:
${details}

Your verdict: PHISHING — ${ctx.reason}

Explain in plain language. Be specific about this page, not generic.`;
}

function renderMarkdown(text) {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escaped
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm,  "<h2>$1</h2>")
    .replace(/^# (.+)$/gm,   "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^\d+\.\s+(.+)$/gm, "<li>$1</li>")
    .replace(/^[\*\-]\s+(.+)$/gm, "<li>$1</li>")
    .replace(/(<li>[\s\S]+?<\/li>)/g, "<ul>$1</ul>")
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

function appendChatMessage(role, text) {
  const wrapper = document.createElement("div");
  wrapper.className = `chat-message ${role}`;

  const roleLabel = document.createElement("div");
  roleLabel.className = "chat-message-role";
  roleLabel.textContent = role === "user" ? "You" : "GonePhishin AI";

  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  if (role === "assistant") {
    bubble.innerHTML = renderMarkdown(text);
  } else {
    bubble.textContent = text;
  }

  wrapper.appendChild(roleLabel);
  wrapper.appendChild(bubble);
  chatMessages.appendChild(wrapper);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return bubble;
}

async function chatSend(text) {
  if (!text.trim() || !pageContext) return;

  appendChatMessage("user", text);
  chatInput.value = "";
  chatInput.style.height = "auto";
  chatSendBtn.disabled = true;

  const thinking = document.createElement("div");
  thinking.className = "chat-message assistant thinking";
  thinking.innerHTML = `<div class="chat-message-role">GonePhishin AI</div><div class="chat-bubble">Thinking...</div>`;
  chatMessages.appendChild(thinking);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  chatHistory.push({ role: "user", parts: [{ text }] });

  try {
    const reply = await chrome.runtime.sendMessage({
      type: "CHAT_MESSAGE",
      payload: { history: chatHistory },
    });

    thinking.remove();

    if (reply.error) {
      appendChatMessage("assistant", `Error: ${reply.error}`);
    } else {
      // Response may be JSON with { text, actions } or plain text
      let replyText = reply.text;
      let actions = [];
      try {
        const parsed = JSON.parse(reply.text.replace(/```json|```/g, "").trim());
        if (parsed.text) {
          replyText = parsed.text;
          actions = parsed.actions ?? [];
        }
      } catch {
        // plain text — use as-is
      }

      appendChatMessage("assistant", replyText);
      chatHistory.push({ role: "model", parts: [{ text: replyText }] });

      if (actions.length > 0) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) {
          chrome.tabs.sendMessage(tab.id, { type: "DOM_ACTIONS", payload: actions });
        }
      }
    }
  } catch (err) {
    thinking.remove();
    appendChatMessage("assistant", `Error: ${err.message}`);
  }

  chatSendBtn.disabled = false;
  chatInput.focus();
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
