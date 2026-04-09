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
});

async function handleChat({ history }) {
  const { apiKey, claudeApiKey, useClaude } = await chrome.storage.sync.get(["apiKey", "claudeApiKey", "useClaude"]);
  if (!apiKey) throw new Error("No API key configured.");

  const response = await fetch(GEMINI_API_URL(apiKey), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: history,
      generationConfig: {
        maxOutputTokens: 1024,
        thinkingConfig: { thinkingBudget: 0 },
      },
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
    console.log("[GonePhishin] Falling back to Claude for chat.");
    // Convert Gemini history format to Claude messages format
    const messages = history.map((m) => ({
      role: m.role === "model" ? "assistant" : "user",
      content: m.parts.map((p) => p.text).join(""),
    }));

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
        messages,
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
