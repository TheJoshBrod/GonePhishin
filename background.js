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
  console.log("[PhishGuard] Sending request to Gemini for:", signals.url);
  console.log("[PhishGuard] Prompt length:", prompt.length, "chars");

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

  console.log("[PhishGuard] Gemini response status:", response.status);

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.find((p) => p.text)?.text ?? "";
  console.log("[PhishGuard] Gemini raw response:", text);

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
  if (message.type !== "ANALYZE_PAGE") return false;

  console.log("[PhishGuard] Received ANALYZE_PAGE for:", message.payload?.url);

  handleAnalysis(message.payload)
    .then((result) => {
      console.log("[PhishGuard] Analysis complete:", result);
      sendResponse(result);
    })
    .catch((err) => {
      console.error("[PhishGuard] Analysis error:", err);
      sendResponse({ error: err.message });
    });

  return true;
});

async function handleAnalysis(signals) {
  const cached = analysisCache.get(signals.url);
  if (!signals.forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    console.log("[PhishGuard] Returning cached result for:", signals.url);
    return cached.result;
  }

  const { apiKey } = await chrome.storage.sync.get("apiKey");
  if (!apiKey) {
    return {
      isPhishing: false,
      confidence: "low",
      reason: "No API key configured. Visit extension options to add one.",
    };
  }

  const result = await analyzeWithGemini(signals, apiKey);
  analysisCache.set(signals.url, { result, timestamp: Date.now() });
  return result;
}
