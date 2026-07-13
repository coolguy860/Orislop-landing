importScripts("aiClassifierModel.generated.js", "classifier.js");

(() => {
  "use strict";

  const MAX_BATCH_SIZE = 10;
  const OLLAMA_TIMEOUT_MS = 15000;
  const OLLAMA_URL = "http://127.0.0.1:11434";
  const DETECTOR_TIMEOUT_MS = 7000;
  const DETECTOR_URL = "http://127.0.0.1:4317";
  const DEFAULT_MODEL = "qwen2.5:1.5b-instruct";
  const ollamaCache = new Map();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "orislop.scoreBatch") {
      const candidates = Array.isArray(message.candidates) ? message.candidates.slice(0, MAX_BATCH_SIZE) : [];
      scoreBatch(candidates, message.settings || {})
        .then(sendResponse)
        .catch((error) => sendResponse({
          ok: false,
          ollamaStatus: "error",
          detectorStatus: "error",
          error: error instanceof Error ? error.message : String(error),
          results: candidates.map((candidate) => OrislopClassifier.scoreCandidate(candidate))
        }));
      return true;
    }

    if (message?.type === "orislop.testOllama") {
      testOllama(message.model)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: friendlyOllamaError(error) }));
      return true;
    }

    if (message?.type === "orislop.testDetector") {
      testDetector()
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: friendlyDetectorError(error) }));
      return true;
    }

    return false;
  });

  async function scoreBatch(candidates, settings) {
    const localResults = candidates.map((candidate) => OrislopClassifier.scoreCandidate(candidate));
    const model = sanitizeModel(settings.ollamaModel);
    const eligible = candidates
      .map((candidate, index) => ({ candidate, index, local: localResults[index] }))
      .filter(({ candidate, local }) => local.hardAiSynthetic !== true && classifierText(candidate).length >= 12);
    const pending = [];
    const cachedDecisions = new Map();
    for (const item of eligible) {
      const cacheKey = createCacheKey(model, item.candidate);
      const cached = ollamaCache.get(cacheKey);
      if (cached) cachedDecisions.set(item.index, cached);
      else pending.push({ ...item, cacheKey });
    }

    let ollamaStatus = cachedDecisions.size > 0 ? "available" : eligible.length === 0 ? "no_text" : "unavailable";
    let ollamaError = "";
    if (pending.length > 0) {
      try {
        const decisions = await classifyWithOllama(pending, model);
        for (const item of pending) {
          const decision = decisions.get(item.index);
          if (!decision) continue;
          cachedDecisions.set(item.index, decision);
          rememberOllamaDecision(item.cacheKey, decision);
        }
        ollamaStatus = "available";
      } catch (caught) {
        ollamaStatus = "unavailable";
        ollamaError = friendlyOllamaError(caught);
      }
    }

    const textResults = localResults.map((local, index) => OrislopClassifier.mergeOllamaDecision(
      local,
      cachedDecisions.get(index) || { available: false, status: ollamaStatus }
    ));
    const detector = await classifyWithDetector(candidates, textResults);
    return {
      ok: true,
      ollamaStatus: localResults.every((result) => result.hardAiSynthetic) ? "bypassed_hard_ai" : ollamaStatus,
      ollamaError,
      detectorStatus: detector.status,
      detectorError: detector.error,
      model,
      results: detector.results
    };
  }

  async function classifyWithDetector(candidates, textResults) {
    const eligible = candidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ index }) => textResults[index].hardAiSynthetic !== true);
    if (eligible.length === 0) return { status: "bypassed_hard_ai", error: "", results: textResults };
    try {
      const response = await fetchWithTimeout(`${DETECTOR_URL}/v1/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidates: eligible.map(({ candidate, index }) => ({
            id: String(index),
            url: clean(candidate.url, 2000),
            mediaUrl: clean(candidate.mediaUrl, 4000)
          }))
        })
      }, DETECTOR_TIMEOUT_MS);
      if (!response.ok) throw new Error(`Detector bridge returned ${response.status}`);
      const payload = await response.json();
      if (!payload.ok || !Array.isArray(payload.results)) throw new Error(payload.error || "Detector bridge response was invalid");
      const decisions = new Map(payload.results.map((decision) => [Number(decision.id), decision]));
      const results = textResults.map((result, index) => OrislopClassifier.mergeDetectorDecision(
        result,
        decisions.get(index) || { status: "pending" }
      ));
      return { status: payload.state || "pending", error: "", results };
    } catch (error) {
      const message = friendlyDetectorError(error);
      return {
        status: "unavailable",
        error: message,
        results: textResults.map((result) => OrislopClassifier.mergeDetectorDecision(result, { status: "unavailable", error: message }))
      };
    }
  }

  async function classifyWithOllama(items, model) {
    const compactItems = items.map(({ candidate, index }) => ({
      id: String(index),
      platform: candidate.platform || "unknown",
      title: clean(candidate.title, 240),
      creator: clean(candidate.channelName, 120),
      metadata_and_transcript: classifierText(candidate)
    }));
    const schema = {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              verdict: { type: "string", enum: ["dont_skip", "skip"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              reason: { type: "string" }
            },
            required: ["id", "verdict", "confidence", "reason"]
          }
        }
      },
      required: ["results"]
    };
    const prompt = [
      "You are the required Orislop classifier. Classify every item as dont_skip or skip.",
      "Skip low-value slop: recycled clips, synthetic Reddit/story narration over unrelated gameplay, content-farm repetition, engagement bait, scam bait, or empty attention bait.",
      "Choose dont_skip for educational explanations, tutorials, original commentary, news, art, comedy, music, and normal personal videos.",
      "A separate hard rule already handles explicit AI/synthetic disclosures. Judge the remaining content from its title, metadata, caption, and transcript.",
      "When uncertain choose dont_skip. Use the exact JSON schema and keep each reason under 18 words.",
      JSON.stringify(compactItems)
    ].join("\n");

    const response = await fetchWithTimeout(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        format: schema,
        keep_alive: "5m",
        options: { temperature: 0, num_predict: 420 }
      })
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama returned ${response.status}: ${clean(body, 180)}`);
    }
    const payload = await response.json();
    const parsed = JSON.parse(payload.response || "{}");
    const results = new Map();
    for (const decision of Array.isArray(parsed.results) ? parsed.results : []) {
      const index = Number(decision.id);
      if (!Number.isInteger(index) || !items.some((item) => item.index === index)) continue;
      results.set(index, {
        available: true,
        verdict: decision.verdict === "skip" ? "skip" : "dont_skip",
        confidence: Math.max(0, Math.min(1, Number(decision.confidence) || 0)),
        reason: clean(decision.reason, 180)
      });
    }
    return results;
  }

  async function testOllama(modelInput) {
    const model = sanitizeModel(modelInput);
    const response = await fetchWithTimeout(`${OLLAMA_URL}/api/tags`, { method: "GET" }, 5000);
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const payload = await response.json();
    const installed = (payload.models || []).some((entry) => entry.name === model || entry.model === model);
    return {
      ok: true,
      model,
      installed,
      message: installed ? `${model} is ready.` : `Ollama is running, but ${model} is not installed.`
    };
  }

  async function testDetector() {
    const response = await fetchWithTimeout(`${DETECTOR_URL}/health`, { method: "GET" }, 5000);
    if (!response.ok) throw new Error(`Detector bridge returned ${response.status}`);
    const payload = await response.json();
    const models = payload.models || {};
    return {
      ok: payload.ok === true,
      state: payload.state || "idle",
      dependencies: payload.dependencies || "unknown",
      models,
      message: payload.dependencies === "missing"
        ? "Detector bridge is running, but Python model dependencies are missing."
        : `Detector bridge is running (${payload.accelerator || "unknown"}); spatial and temporal models are configured.`
    };
  }

  function fetchWithTimeout(url, options, timeoutMs = OLLAMA_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timeout));
  }

  function classifierText(candidate) {
    return clean([
      candidate.title,
      candidate.channelName,
      candidate.visibleText,
      candidate.transcriptText
    ].filter(Boolean).join(" "), 1800);
  }

  function createCacheKey(model, candidate) {
    return `${model}|${candidate.platform || ""}|${candidate.itemId || candidate.url || ""}|${hashText(classifierText(candidate))}`;
  }

  function rememberOllamaDecision(key, value) {
    ollamaCache.set(key, value);
    while (ollamaCache.size > 500) ollamaCache.delete(ollamaCache.keys().next().value);
  }

  function hashText(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function sanitizeModel(value) {
    const model = String(value || DEFAULT_MODEL).trim();
    return /^[a-zA-Z0-9._:/-]{1,100}$/.test(model) ? model : DEFAULT_MODEL;
  }

  function clean(value, limit) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function friendlyOllamaError(error) {
    if (error?.name === "AbortError") return "Ollama timed out. Local scoring stayed active.";
    const message = error instanceof Error ? error.message : String(error);
    if (/failed to fetch|networkerror/i.test(message)) return "Could not reach Ollama at 127.0.0.1:11434. Local scoring stayed active.";
    return clean(message, 220) || "Ollama was unavailable. Local scoring stayed active.";
  }

  function friendlyDetectorError(error) {
    if (error?.name === "AbortError") return "Spatiotemporal detector bridge timed out while accepting the scan.";
    const message = error instanceof Error ? error.message : String(error);
    if (/failed to fetch|networkerror/i.test(message)) return "Could not reach the required detector bridge at 127.0.0.1:4317.";
    return clean(message, 240) || "The spatiotemporal detector bridge was unavailable.";
  }
})();
