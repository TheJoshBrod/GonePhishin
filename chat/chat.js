/**
 * chat.js — Phishing explanation chat page.
 * Loads page context from storage, then lets the user chat with Gemini about it.
 */

const messagesEl = document.getElementById("messages");
const inputEl    = document.getElementById("input");
const sendBtn    = document.getElementById("send-btn");

// Conversation history in Gemini format: [{role, parts:[{text}]}]
let history = [];
let pageContext = null;

// ── Load context from storage ─────────────────────────────────────────────────

async function init() {
  const { chatContext } = await chrome.storage.local.get("chatContext");
  if (!chatContext) {
    appendMessage("assistant", "No phishing context found. Open this chat from a flagged page.");
    return;
  }

  pageContext = chatContext;
  document.getElementById("page-url").textContent = pageContext.url;
  document.getElementById("initial-reason").textContent = pageContext.reason;

  // Seed history with context so Gemini knows what was analyzed
  const contextMessage = buildContextMessage(pageContext);
  history.push({ role: "user", parts: [{ text: contextMessage }] });
  history.push({ role: "model", parts: [{ text: `Understood. I've analyzed this page and flagged it as a phishing attempt. The main reason: ${pageContext.reason} I'm ready to answer any questions about why this page is suspicious.` }] });

  appendMessage("assistant", `I flagged this page as phishing. ${pageContext.reason}\n\nAsk me anything about why — use the suggestions on the left or type your own question.`);
}

function buildContextMessage(ctx) {
  return `You are a cybersecurity expert helping a user understand why a webpage was flagged as phishing.

Page details you analyzed:
- URL: ${ctx.url}
- Title: ${ctx.title}
- Has password/login form: ${ctx.hasLoginForm}
- Has favicon: ${ctx.hasFavicon}
- Iframes: ${ctx.iframeCount}
- External links: ${ctx.externalLinkCount} of ${ctx.linkCount} total
- Page text snippet: ${ctx.bodyText?.slice(0, 400) ?? ""}

Your verdict: PHISHING — ${ctx.reason}

The user wants to understand your reasoning. Be clear, educational, and helpful. Explain in plain language.`;
}

// ── Messaging ─────────────────────────────────────────────────────────────────

function renderMarkdown(text) {
  // Escape HTML first to prevent XSS
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escaped
    // Headers
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm,  "<h2>$1</h2>")
    .replace(/^# (.+)$/gm,   "<h1>$1</h1>")
    // Bold
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Italic (single asterisk, not touching bold)
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>")
    // Inline code
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // Numbered list items
    .replace(/^\d+\.\s+(.+)$/gm, "<li>$1</li>")
    // Bullet list items (* or -)
    .replace(/^[\*\-]\s+(.+)$/gm, "<li>$1</li>")
    // Wrap consecutive <li> runs in <ol> or <ul>
    .replace(/(<li>[\s\S]+?<\/li>)/g, "<ul>$1</ul>")
    // Paragraphs — blank lines become <br><br>
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

function appendMessage(role, text) {
  const wrapper = document.createElement("div");
  wrapper.className = `message ${role}`;

  const roleLabel = document.createElement("div");
  roleLabel.className = "message-role";
  roleLabel.textContent = role === "user" ? "You" : "GonePhishin AI";

  const bubble = document.createElement("div");
  bubble.className = "message-bubble";

  if (role === "assistant") {
    bubble.innerHTML = renderMarkdown(text);
  } else {
    bubble.textContent = text;
  }

  wrapper.appendChild(roleLabel);
  wrapper.appendChild(bubble);
  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return bubble;
}

async function send(text) {
  if (!text.trim() || !pageContext) return;

  appendMessage("user", text);
  inputEl.value = "";
  sendBtn.disabled = true;

  // Show thinking indicator
  const thinkingWrapper = document.createElement("div");
  thinkingWrapper.className = "message assistant thinking";
  thinkingWrapper.innerHTML = `<div class="message-role">GonePhishin AI</div><div class="message-bubble">Thinking...</div>`;
  messagesEl.appendChild(thinkingWrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  history.push({ role: "user", parts: [{ text }] });

  try {
    const reply = await chrome.runtime.sendMessage({
      type: "CHAT_MESSAGE",
      payload: { history },
    });

    thinkingWrapper.remove();

    if (reply.error) {
      appendMessage("assistant", `Error: ${reply.error}`);
    } else {
      appendMessage("assistant", reply.text);
      history.push({ role: "model", parts: [{ text: reply.text }] });
    }
  } catch (err) {
    thinkingWrapper.remove();
    appendMessage("assistant", `Error: ${err.message}`);
  }

  sendBtn.disabled = false;
  inputEl.focus();
}

// ── Event listeners ───────────────────────────────────────────────────────────

sendBtn.addEventListener("click", () => send(inputEl.value));

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send(inputEl.value);
  }
});

// Auto-resize textarea
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = `${inputEl.scrollHeight}px`;
});

// Suggestion buttons
document.querySelectorAll(".suggestion-btn").forEach((btn) => {
  btn.addEventListener("click", () => send(btn.dataset.q));
});

init();
