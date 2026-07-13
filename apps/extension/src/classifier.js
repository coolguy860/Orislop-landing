(() => {
  "use strict";

  const SKIP_THRESHOLD = 72;
  const EDUCATIONAL_PATTERN = /\b(explain|explains|explained|explaining|lesson|lecture|tutorial|course|classroom|science|scientific|history|historical|math|mathematics|physics|chemistry|biology|engineering|programming|coding|documentary|analysis|research|experiment|how\s+to|learn|educational|education|professor|teacher|study|evidence|source|sourced)\b/;
  const STORY_PATTERN = /\b(reddit|askreddit|aita|storytime|reddit\s+story|reddit\s+stories|reddit\s+thread)\b/;
  const BACKGROUND_PATTERN = /\b(minecraft\s+parkour|subway\s+surfers|mobile\s+game(?:play)?|parkour\s+gameplay|minecraft\s+gameplay|satisfying\s+background|split\s+screen)\b/;
  const SYNTHETIC_NARRATION_PATTERN = /\b(ai\s+voice(?:over)?|text\s+to\s+speech|tts|robot\s+voice|synthetic\s+voice|voice\s+clone)\b/;
  const RECYCLED_PATTERN = /\b(repost(?:ed)?|re-?upload(?:ed)?|clips?\s+compilation|viral\s+clips|family\s+guy\s+clips|no\s+commentary|source\s+unknown|credit\s+unknown|not\s+mine|green\s*screen)\b/;
  const EXPLICIT_SLOP_PATTERN = /\b(brainrot|content\s+farm|ai\s+slop|subway\s+surfers|family\s+guy\s+clips)\b/;
  const SCAM_PATTERN = /\b(guaranteed\s+(?:passive\s+)?income|make\s+money\s+fast|miracle\s+cure|doctors\s+hate|banks\s+hate|they\s+don'?t\s+want\s+you\s+to\s+know|secret\s+trick|claim\s+your\s+prize)\b/;
  const CLICKBAIT_PATTERN = /\b(you\s+won'?t\s+believe|wait\s+for\s+it|watch\s+(?:till|until)\s+the\s+end|this\s+changed\s+everything|before\s+they\s+delete\s+this|insane\s+ending|shocking)\b/;
  const ENGAGEMENT_PATTERN = /\b(like\s+and\s+follow|subscribe\s+for\s+more|follow\s+for\s+(?:more|part)|comment\s+below|tag\s+someone|share\s+this\s+with)\b/;
  const SENSORY_PATTERN = /\b(oddly\s+satisfying|satisfying\s+(?:video|compilation|background)|asmr\s+compilation|ranking\s+the\s+most\s+satisfying)\b/;
  const AI_DISCLOSURE_PATTERN = /\b(altered\s+or\s+synthetic(?:\s+content)?|created\s+or\s+altered\s+with\s+ai|generated\s+by\s+ai|generated\s+with\s+ai|made\s+with\s+ai|created\s+with\s+ai|ai[-\s]+generated(?:\s+content)?|artificially\s+generated|synthetic\s+content|digitally\s+generated|deepfake|sora\s+generated|ai\s+(?:cover|song|music))\b/;

  const AI_MODEL = globalThis.ORISLOP_AI_CLASSIFIER_V1;
  const AI_MODEL_AVAILABLE = Boolean(AI_MODEL && Array.isArray(AI_MODEL.features) && AI_MODEL.features.length > 0);
  const AI_MODEL_INTERCEPT = Number.isFinite(AI_MODEL?.intercept) ? AI_MODEL.intercept : 0;
  const AI_FEATURE_MAP = new Map((AI_MODEL?.features || []).map(({ term, idf, weight }) => [term, { idf, weight }]));
  const AI_STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "i", "in", "is", "it", "my", "of", "on", "or", "the", "this", "to", "with", "you", "your"]);

  function scoreCandidate(input = {}) {
    const parsed = parsePlatformUrl(input.url, input.platform, input.itemId);
    const title = cleanText(input.title, 400);
    const description = cleanText(input.visibleText || input.description, 1800);
    const transcript = cleanText(input.transcriptText, 1800);
    const channelName = cleanText(input.channelName, 240);
    const text = normalize([title, description, transcript, channelName].filter(Boolean).join(" "));
    const signals = [];
    const strongCategories = new Set();

    const add = (label, points, category = null) => {
      signals.push({ label, points });
      if (category) strongCategories.add(category);
    };

    const hasStory = STORY_PATTERN.test(text);
    const hasBackground = BACKGROUND_PATTERN.test(text);
    const hasSyntheticNarration = SYNTHETIC_NARRATION_PATTERN.test(text);
    const hasAiDisclosure = AI_DISCLOSURE_PATTERN.test(text);
    const hardAiSynthetic = hasSyntheticNarration || hasAiDisclosure;
    const stackedParts = [hasStory, hasBackground, hasSyntheticNarration].filter(Boolean).length;
    const hardStackedFormat = stackedParts >= 2;

    if (hardStackedFormat) add("Stacked story/background format", stackedParts === 3 ? 46 : 38, "stacked_format");
    if (hasStory) add("Reddit/story-farm source", 14, "story_farm");
    if (hasBackground) add("Unrelated looping gameplay", 16, "background_gameplay");
    if (hasSyntheticNarration) add("Synthetic narration", 22, "synthetic_narration");
    if (RECYCLED_PATTERN.test(text)) add("Repost or low-originality clips", 25, "recycled_content");
    if (EXPLICIT_SLOP_PATTERN.test(text)) add("Explicit slop/content-farm format", 28, "explicit_slop");
    if (SCAM_PATTERN.test(text)) add("Scam or extreme claim bait", 34, "scam_bait");
    if (CLICKBAIT_PATTERN.test(text)) add("Clickbait wording", 9);
    if (ENGAGEMENT_PATTERN.test(text)) add("Engagement bait", 10);
    if (SENSORY_PATTERN.test(text) && !isMusicContext(text)) add("Sensory filler format", 10);
    if (hasAiDisclosure) add("AI/synthetic disclosure", 5);
    if (emojiCount(text) >= 5) add("Heavy emoji pattern", 5);
    if (/[!?]{4,}/.test(text)) add("Spammy punctuation", 5);

    const educational = EDUCATIONAL_PATTERN.test(normalize([title, description, transcript].join(" ")));
    const metadataAi = runMetadataModel({
      title,
      description: [description, transcript].filter(Boolean).join(" "),
      channelName,
      isShort: parsed.itemKind === "short",
      durationSeconds: Number(input.durationSeconds) || 0
    });

    if (hardAiSynthetic) {
      const hardReason = hasAiDisclosure ? "AI/synthetic content detected" : "Synthetic narration detected";
      return {
        score: 100,
        recommendation: "skip",
        reasons: [hardReason],
        confidence: "high",
        platform: parsed.platform,
        itemId: parsed.itemId,
        itemKind: parsed.itemKind,
        normalizedUrl: parsed.normalizedUrl,
        educationalProtected: false,
        hardAiSynthetic: true,
        hardStackedFormat,
        strongEvidenceCount: strongCategories.size,
        signalBreakdown: [...signals, { label: "Hard AI/synthetic override", points: 100 }],
        aiClassifierUsed: metadataAi.available,
        aiClassifier: metadataAi,
        ollamaUsed: false,
        sourceScores: {
          heuristic: 100,
          metadataModel: metadataAi.available ? metadataAi.score : null,
          ollama: null,
          spatial: null,
          temporal: null
        },
        thresholds: { skip: SKIP_THRESHOLD }
      };
    }
    const metadataAdjustment = metadataAi.available
      ? metadataAi.score >= 82 ? 10 : metadataAi.score <= 25 ? -8 : 0
      : 0;
    if (metadataAdjustment > 0) add("Local metadata model support", metadataAdjustment);

    const strongEvidenceCount = strongCategories.size;
    const stackedBoost = strongEvidenceCount >= 3 ? 15 : strongEvidenceCount >= 2 ? 25 : 0;
    const educationProtection = educational && !hardStackedFormat && !strongCategories.has("scam_bait") ? 34 : 0;
    const rawScore = signals.reduce((sum, signal) => sum + signal.points, 0) + stackedBoost + Math.min(0, metadataAdjustment);
    const score = clampScore(rawScore - educationProtection);
    const enoughEvidence = hardStackedFormat || strongEvidenceCount >= 2;
    const recommendation = "watch";
    const positiveReasons = signals.filter((signal) => signal.points > 0).map((signal) => signal.label);
    const reasons = educational
        ? ["Educational/useful context protected", ...positiveReasons.slice(0, 2)]
        : enoughEvidence && score >= SKIP_THRESHOLD
          ? ["Strong local slop signals; awaiting Ollama verdict", ...positiveReasons.slice(0, 3)]
          : positiveReasons.length > 0
            ? ["Awaiting Ollama verdict", ...positiveReasons.slice(0, 2)]
            : ["Awaiting Ollama verdict"];

    return {
      score,
      recommendation,
      reasons,
      confidence: recommendation === "skip" && (hardStackedFormat || strongEvidenceCount >= 3) ? "high" : score <= 30 ? "high" : "medium",
      platform: parsed.platform,
      itemId: parsed.itemId,
      itemKind: parsed.itemKind,
      normalizedUrl: parsed.normalizedUrl,
      educationalProtected: educationProtection > 0,
      hardAiSynthetic: false,
      hardStackedFormat,
      strongEvidenceCount,
      signalBreakdown: signals,
      aiClassifierUsed: metadataAi.available,
      aiClassifier: metadataAi,
      ollamaUsed: false,
      sourceScores: {
        heuristic: clampScore(rawScore),
        metadataModel: metadataAi.available ? metadataAi.score : null,
        ollama: null,
        spatial: null,
        temporal: null
      },
      thresholds: { skip: SKIP_THRESHOLD }
    };
  }

  function mergeOllamaDecision(localDecision, ollamaDecision) {
    if (localDecision.hardAiSynthetic === true) {
      return {
        ...localDecision,
        score: 100,
        recommendation: "skip",
        ollamaUsed: false,
        ollamaStatus: "bypassed_hard_ai"
      };
    }

    if (!ollamaDecision || ollamaDecision.available !== true) {
      return {
        ...localDecision,
        recommendation: "watch",
        ollamaUsed: false,
        ollamaStatus: ollamaDecision?.status || "unavailable"
      };
    }

    const confidence = Math.max(0, Math.min(1, Number(ollamaDecision.confidence) || 0));
    const verdict = ollamaDecision.verdict === "skip" ? "skip" : "dont_skip";
    const recommendation = verdict === "skip" ? "skip" : "watch";
    const score = verdict === "skip"
      ? Math.max(SKIP_THRESHOLD, Math.round(72 + confidence * 28))
      : Math.min(localDecision.score, Math.round((1 - confidence) * 44));

    const reason = cleanText(ollamaDecision.reason, 180) || (verdict === "skip" ? "Local transcript model detected slop" : "Local transcript model protected this item");
    return {
      ...localDecision,
      score,
      recommendation,
      reasons: [reason, ...localDecision.reasons].slice(0, 4),
      ollamaUsed: true,
      ollamaStatus: "available",
      ollamaDecision: { verdict, confidence, reason },
      sourceScores: {
        ...localDecision.sourceScores,
        ollama: Math.round(confidence * 100) * (verdict === "skip" ? 1 : -1)
      }
    };
  }

  function mergeDetectorDecision(textDecision, detectorDecision) {
    const status = cleanText(detectorDecision?.status, 40) || "unavailable";
    if (status !== "ready") {
      return {
        ...textDecision,
        detectorUsed: false,
        detectorStatus: status,
        detectorError: cleanText(detectorDecision?.error, 240)
      };
    }

    const spatialProbability = detectorDecision?.spatial?.available === true
      ? clampProbability(detectorDecision.spatial.ai_probability)
      : null;
    const temporalProbability = detectorDecision?.temporal?.available === true
      ? clampProbability(detectorDecision.temporal.fake_probability)
      : null;
    const detectorScore = clampScore(detectorDecision.score);
    const sourceScores = {
      ...textDecision.sourceScores,
      spatial: spatialProbability === null ? null : Math.round(spatialProbability * 100),
      temporal: temporalProbability === null ? null : Math.round(temporalProbability * 100)
    };
    if (detectorDecision.synthetic === true) {
      const reason = cleanText(detectorDecision.reason, 180) || "Spatiotemporal detector found synthetic media";
      return {
        ...textDecision,
        score: 100,
        recommendation: "skip",
        reasons: [reason, ...textDecision.reasons].slice(0, 4),
        confidence: "high",
        hardAiSynthetic: true,
        visualAiSynthetic: true,
        detectorUsed: true,
        detectorStatus: "available",
        detectorDecision: { score: detectorScore, reason },
        sourceScores
      };
    }
    return {
      ...textDecision,
      detectorUsed: true,
      detectorStatus: "available",
      detectorDecision: {
        score: detectorScore,
        reason: cleanText(detectorDecision.reason, 180) || "No strong synthetic-media signal"
      },
      sourceScores
    };
  }

  function parsePlatformUrl(input, platformHint = "", itemIdHint = "") {
    const raw = String(input || "").trim();
    let url;
    try {
      url = new URL(raw || "https://invalid.local/");
    } catch {
      url = new URL("https://invalid.local/");
    }
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split("/").filter(Boolean);
    let platform = normalizePlatform(platformHint);
    let itemId = cleanId(itemIdHint);
    let itemKind = "video";

    if (!platform && (host.endsWith("youtube.com") || host === "youtu.be")) platform = "youtube";
    if (!platform && host.endsWith("instagram.com")) platform = "instagram";
    if (!platform && host.endsWith("tiktok.com")) platform = "tiktok";

    if (platform === "youtube") {
      const shortId = parts[0] === "shorts" ? cleanId(parts[1]) : null;
      itemId = itemId || shortId || cleanId(url.searchParams.get("v")) || (host === "youtu.be" ? cleanId(parts[0]) : null);
      itemKind = shortId ? "short" : "video";
    } else if (platform === "instagram") {
      const marker = ["reel", "reels", "p"].includes(parts[0]) ? parts[0] : "";
      itemId = itemId || (marker ? cleanId(parts[1]) : null);
      itemKind = marker === "p" ? "post" : "short";
    } else if (platform === "tiktok") {
      const videoIndex = parts.indexOf("video");
      itemId = itemId || (videoIndex >= 0 ? cleanId(parts[videoIndex + 1]) : null);
      itemKind = "short";
    }

    return {
      platform: platform || "unknown",
      itemId,
      itemKind,
      normalizedUrl: platform && itemId ? raw : raw || null
    };
  }

  function runMetadataModel(input) {
    if (!AI_MODEL_AVAILABLE) {
      return { available: false, modelId: "orislop-ai-classifier-v1", score: 0, probability: 0, topFeatures: [] };
    }
    const tokens = normalize([input.title, input.description, input.channelName].join(" ")).match(/[a-z0-9][a-z0-9_'-]*/g) || [];
    const filtered = tokens.filter((token) => token.length > 1 && !AI_STOP_WORDS.has(token));
    const terms = [...filtered, ...filtered.slice(0, -1).map((token, index) => `${token}_${filtered[index + 1]}`)];
    terms.push(input.isShort ? "__short__" : "__watch__");
    if (input.durationSeconds > 0 && input.durationSeconds <= 75) terms.push("__duration_short__");
    const counts = new Map();
    for (const term of terms) {
      if (AI_FEATURE_MAP.has(term)) counts.set(term, (counts.get(term) || 0) + 1);
    }
    const total = Array.from(counts.values()).reduce((sum, value) => sum + value, 0) || 1;
    const weighted = Array.from(counts, ([term, count]) => {
      const feature = AI_FEATURE_MAP.get(term);
      return { term, value: (count / total) * feature.idf, weight: feature.weight };
    });
    const norm = Math.sqrt(weighted.reduce((sum, feature) => sum + feature.value * feature.value, 0)) || 1;
    const contributions = weighted.map((feature) => ({ term: feature.term, contribution: (feature.value * feature.weight) / norm }));
    const probability = sigmoid(AI_MODEL_INTERCEPT + contributions.reduce((sum, feature) => sum + feature.contribution, 0));
    return {
      available: true,
      modelId: AI_MODEL?.modelId || "orislop-ai-classifier-v1",
      probability,
      score: Math.round(probability * 100),
      topFeatures: contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 4)
    };
  }

  function normalizePlatform(value) {
    const normalized = String(value || "").toLowerCase();
    return ["youtube", "instagram", "tiktok"].includes(normalized) ? normalized : "";
  }

  function cleanId(value) {
    const id = String(value || "").trim();
    return /^[a-zA-Z0-9_.-]{3,160}$/.test(id) ? id : null;
  }

  function cleanText(value, limit) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function normalize(value) {
    return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function emojiCount(value) {
    return Array.from(value).filter((char) => /\p{Extended_Pictographic}/u.test(char)).length;
  }

  function isMusicContext(text) {
    return /\b(song|lyrics|music|track|cover|remix|karaoke|performance)\b/.test(text);
  }

  function sigmoid(value) {
    if (value >= 0) {
      const z = Math.exp(-value);
      return 1 / (1 + z);
    }
    const z = Math.exp(value);
    return z / (1 + z);
  }

  function clampProbability(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
  }

  function clampScore(value) {
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  globalThis.OrislopClassifier = Object.freeze({
    mergeDetectorDecision,
    mergeOllamaDecision,
    parsePlatformUrl,
    scoreCandidate
  });
})();
