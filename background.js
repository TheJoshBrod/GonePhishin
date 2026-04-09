/**
 * background.js — Service worker.
 * Receives page signals from content.js, calls Gemini API, returns verdict.
 */

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_API_URL = (key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const analysisCache = new Map();

// ── Gemini API Call ───────────────────────────────────────────────────────────

async function analyzeWithGemini(signals, apiKey) {
  const prompt = buildPrompt(signals);
  console.log("[GonePhishin] Sending request to Gemini for:", signals.url);
  console.log("[GonePhishin] Prompt length:", prompt.length, "chars");

  const response = await fetch(GEMINI_API_URL(apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{
          text: `You are a phishing detector. Reply with ONLY a JSON object, no markdown.
Schema: {"isPhishing":boolean,"confidence":"high"|"medium"|"low","reason":"one sentence"}`
        }]
      },
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 512,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });

  console.log("[GonePhishin] Gemini response status:", response.status);

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.find((p) => p.text)?.text ?? "";
  console.log("[GonePhishin] Gemini raw response:", text);

  const cleaned = text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

// ── Claude API Call ───────────────────────────────────────────────────────────

const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";

async function analyzeWithClaude(signals, apiKey) {
  const prompt = buildPrompt(signals);
  console.log("[GonePhishin] Falling back to Claude for:", signals.url);

  const response = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 512,
      system: `You are a phishing detector. Reply with ONLY a JSON object, no markdown.
Schema: {"isPhishing":boolean,"confidence":"high"|"medium"|"low","reason":"one sentence"}`,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  console.log("[GonePhishin] Claude response status:", response.status);

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text ?? "";
  console.log("[GonePhishin] Claude raw response:", text);

  const cleaned = text.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
}

function buildPrompt(signals) {
  return `URL: ${signals.url}
Title: ${signals.title}
Has password form: ${signals.hasLoginForm}
Has favicon: ${signals.hasFavicon}
Iframes: ${signals.iframeCount}
External links: ${signals.externalLinkCount} of ${signals.linkCount} total
Page text snippet: ${signals.bodyText.slice(0, 300)}`;
}

// ── Message Handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "ANALYZE_PAGE") {
    console.log("[GonePhishin] Received ANALYZE_PAGE for:", message.payload?.url);
    handleAnalysis(message.payload)
      .then((result) => {
        console.log("[GonePhishin] Analysis complete:", result);
        sendResponse(result);
      })
      .catch((err) => {
        console.error("[GonePhishin] Analysis error:", err);
        sendResponse({ error: err.message });
      });
    return true;
  }

  if (message.type === "OPEN_CHAT") {
    chrome.tabs.create({ url: chrome.runtime.getURL("chat/chat.html") });
    return false;
  }

  if (message.type === "CHAT_MESSAGE") {
    handleChat(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === "HIGHLIGHT_REQUEST") {
    handleHighlight(message.payload)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

const CHAT_SYSTEM_PROMPT = `You are a cybersecurity expert helping a user understand why a webpage was flagged as phishing.

You can highlight, annotate, or hide elements on the live page to visually explain your points. When you want to modify the page, append a fenced code block at the very end of your response:

\`\`\`phishguard-actions
[{"type":"highlight|annotate|hide","selector":"css selector","label":"short label shown on page"}]
\`\`\`

Action types:
- highlight: amber outline + label on the element, scrolls it into view
- annotate: blue info label placed after the element
- hide: hides the element to show what a real site would not include

Only include the actions block when referencing specific page elements. Otherwise respond in plain markdown.
Be specific to the actual page — reference the URL, brand being faked, etc.`;

function toClaudeMessages(history) {
  return history.map((m) => ({
    role: m.role === "model" ? "assistant" : "user",
    content: m.parts.map((p) => p.text).join(""),
  }));
}

// ── Streaming chat via long-lived port ────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "chat-stream") return;

  port.onMessage.addListener(async ({ history }) => {
    const { apiKey, claudeApiKey, useClaude } = await chrome.storage.sync.get(["apiKey", "claudeApiKey", "useClaude"]);

    if (!apiKey) {
      port.postMessage({ error: "No API key configured." });
      port.disconnect();
      return;
    }

    try {
      await streamChatGemini(history, apiKey, port);
    } catch (geminiErr) {
      console.warn("[GonePhishin] Gemini stream failed:", geminiErr.message);
      if (useClaude && claudeApiKey) {
        try {
          await streamChatClaude(history, claudeApiKey, port);
        } catch (claudeErr) {
          port.postMessage({ error: claudeErr.message });
          port.disconnect();
        }
      } else {
        port.postMessage({ error: geminiErr.message });
        port.disconnect();
      }
    }
  });
});

async function streamChatGemini(history, apiKey, port) {
  const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const response = await fetch(streamUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: CHAT_SYSTEM_PROMPT }] },
      contents: history,
      generationConfig: { maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini stream error ${response.status}: ${err}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const json = JSON.parse(raw);
        const chunk = json.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text ?? "";
        if (chunk) port.postMessage({ chunk });
      } catch { /* malformed line — skip */ }
    }
  }

  port.postMessage({ done: true });
  port.disconnect();
}

async function streamChatClaude(history, apiKey, port) {
  const response = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      stream: true,
      system: CHAT_SYSTEM_PROMPT,
      messages: toClaudeMessages(history),
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude stream error ${response.status}: ${err}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (!raw || raw === "[DONE]") continue;
      try {
        const json = JSON.parse(raw);
        if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
          port.postMessage({ chunk: json.delta.text });
        }
      } catch { /* skip */ }
    }
  }

  port.postMessage({ done: true });
  port.disconnect();
}

// Keep non-streaming handleChat for any legacy callers (banner "Learn more" flow)
async function handleChat({ history }) {
  const { apiKey, claudeApiKey, useClaude } = await chrome.storage.sync.get(["apiKey", "claudeApiKey", "useClaude"]);
  if (!apiKey) throw new Error("No API key configured.");

  const response = await fetch(GEMINI_API_URL(apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: CHAT_SYSTEM_PROMPT }] },
      contents: history,
      generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });

  if (response.ok) {
    const data = await response.json();
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const text = parts.find((p) => p.text)?.text ?? "";
    return { text };
  }

  const geminiErr = await response.text();
  console.warn("[GonePhishin] Gemini chat failed:", geminiErr);

  if (useClaude && claudeApiKey) {
    const claudeResponse = await fetch(CLAUDE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": claudeApiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1024,
        system: CHAT_SYSTEM_PROMPT,
        messages: toClaudeMessages(history),
      }),
    });

    if (!claudeResponse.ok) {
      const err = await claudeResponse.text();
      throw new Error(`Claude API error ${claudeResponse.status}: ${err}`);
    }

    const claudeData = await claudeResponse.json();
    const text = claudeData.content?.[0]?.text ?? "";
    return { text };
  }

  throw new Error(`Gemini API error ${response.status}: ${geminiErr}`);
}

async function handleHighlight({ signals, reason }) {
  const { apiKey, claudeApiKey, useClaude } = await chrome.storage.sync.get(["apiKey", "claudeApiKey", "useClaude"]);
  if (!apiKey) throw new Error("No API key configured.");

  const prompt = `You flagged this page as phishing with this reasoning: "${reason}"

Page details:
- URL: ${signals.url}
- Title: ${signals.title}
- Iframes: ${signals.iframeCount}
- Hidden inputs: ${signals.hiddenInputCount}
- External links (sample): ${signals.externalLinks.slice(0, 5).join(", ") || "none"}
- Page text snippet: ${signals.bodyText.slice(0, 400)}

Now identify the specific elements on this page that are suspicious. For each element, write a reason that explains WHY it is dangerous in the full context of this specific attack — not just what the element is. Reference the URL, the brand being impersonated, where credentials would be sent, etc. Be explicit and specific.

For example, instead of "Requests the user's password", say "Submitting this form sends your PayPal password to localhost, not to paypal.com — this is a credential-harvesting fake."

Return ONLY a JSON object.
Schema: {"elements":[{"selector":"CSS selector string","reason":"explicit contextual reason"}]}
Use simple, broad selectors (e.g. "form", "iframe", 'input[type=\\"password\\"]'). Return at most 6 elements.`;

  const systemPrompt = `You are a phishing analyst explaining to a non-technical user exactly why specific page elements are dangerous. Always reference the specific attack context (fake brand, suspicious URL, where data would be sent). Never give generic descriptions — be explicit and concrete. Reply with ONLY a JSON object, no markdown.
Schema: {"elements":[{"selector":"string","reason":"string"}]}`;

  let result;
  try {
    const response = await fetch(GEMINI_API_URL(apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 512, thinkingConfig: { thinkingBudget: 0 } },
      }),
    });

    if (!response.ok) throw new Error(`Gemini error ${response.status}`);

    const data = await response.json();
    const text = (data.candidates?.[0]?.content?.parts ?? []).find((p) => p.text)?.text ?? "";
    result = JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch (geminiErr) {
    console.warn("[GonePhishin] Gemini highlight failed:", geminiErr.message);
    if (!useClaude || !claudeApiKey) throw geminiErr;

    const claudeResponse = await fetch(CLAUDE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": claudeApiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!claudeResponse.ok) throw new Error(`Claude error ${claudeResponse.status}`);
    const claudeData = await claudeResponse.json();
    const text = claudeData.content?.[0]?.text ?? "";
    result = JSON.parse(text.replace(/```json|```/g, "").trim());
  }

  return result;
}

async function handleAnalysis(signals) {
  const cached = analysisCache.get(signals.url);
  if (!signals.forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log("[GonePhishin] Returning cached result for:", signals.url);
    return cached.result;
  }

  const { apiKey, claudeApiKey, useClaude } = await chrome.storage.sync.get(["apiKey", "claudeApiKey", "useClaude"]);
  if (!apiKey) {
    return {
      isPhishing: false,
      confidence: "low",
      reason: "No API key configured. Visit extension options to add one.",
    };
  }

  let result;
  try {
    result = await analyzeWithGemini(signals, apiKey);
  } catch (geminiErr) {
    console.warn("[GonePhishin] Gemini failed:", geminiErr.message);
    if (useClaude && claudeApiKey) {
      result = await analyzeWithClaude(signals, claudeApiKey);
    } else {
      throw geminiErr;
    }
  }

  analysisCache.set(signals.url, { result, timestamp: Date.now() });
  return result;
}
