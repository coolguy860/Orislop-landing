(() => {
  "use strict";

  const FLAGGED_KEY = "orislop.extension.flaggedLog";
  const SKIPPED_KEY = "orislop.extension.skippedLog";
  const SETTINGS_KEY = "orislop.extension.settings";
  const OLLAMA_STATUS_KEY = "orislop.extension.ollamaStatus";
  const DETECTOR_STATUS_KEY = "orislop.extension.detectorStatus";
  const PROCESSED_ATTR = "data-orislop-processed";
  const SIGNATURE_ATTR = "data-orislop-signature";
  const ITEM_KEY_ATTR = "data-orislop-item-key";
  const LOOKAHEAD_LIMIT = 10;
  const SCAN_DEBOUNCE_MS = 320;
  const OLLAMA_RESPONSE_TIMEOUT_MS = 18000;
  const DEFAULT_SETTINGS = {
    hideSkipped: true,
    ollamaModel: "qwen2.5:1.5b-instruct"
  };

  let settingsCache = { ...DEFAULT_SETTINGS };
  let scanTimer = 0;
  let scanInFlight = false;
  let scanQueued = false;
  let lastHref = window.location.href;
  let decisionCache = null;
  let historyWriter = null;
  const loggedSkipKeys = new Set();

  if (globalThis.__ORISLOP_TEST__ === true) {
    globalThis.__ORISLOP_EXTENSION_TEST_API__ = Object.freeze({
      normalizeSettings,
      parsePlatformUrl: globalThis.OrislopClassifier?.parsePlatformUrl,
      scoreOneCandidate
    });
  } else {
    boot();
  }

  function boot() {
    if (!globalThis.OrislopExtensionCore || !globalThis.OrislopClassifier) return;
    decisionCache = globalThis.OrislopExtensionCore.createDecisionCache({ limit: 600 });
    historyWriter = globalThis.OrislopExtensionCore.createHistoryWriter({
      readList,
      writeList: (key, records) => chrome.storage.local.set({ [key]: records })
    });

    void loadSettings().then((settings) => {
      settingsCache = settings;
      scheduleScan();
    });

    new MutationObserver(scheduleScan).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("scroll", scheduleScan, { passive: true });
    window.addEventListener("popstate", scheduleScan, { passive: true });
    window.addEventListener("yt-navigate-finish", scheduleScan, { passive: true });
    window.addEventListener("yt-page-data-updated", scheduleScan, { passive: true });
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[SETTINGS_KEY]) return;
      const previous = settingsCache;
      settingsCache = normalizeSettings(changes[SETTINGS_KEY].newValue);
      if (previous.ollamaModel !== settingsCache.ollamaModel) {
        decisionCache.clear();
        resetProcessedState();
      }
      if (previous.hideSkipped && !settingsCache.hideSkipped) restoreAutomaticallyHiddenItems();
      if (!previous.hideSkipped && settingsCache.hideSkipped) resetProcessedState();
      scheduleScan();
    });
  }

  function scheduleScan() {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scanLookahead, SCAN_DEBOUNCE_MS);
  }

  async function scanLookahead() {
    if (scanInFlight) {
      scanQueued = true;
      return;
    }
    scanInFlight = true;
    try {
      syncLocation();
      const jobs = [];
      for (const element of findLookaheadCandidates()) {
        if (!(element instanceof HTMLElement) || element.getAttribute(PROCESSED_ATTR) === "allowed") continue;
        const candidate = extractCandidate(element);
        if (!candidate.itemKey || (!candidate.title && candidate.visibleText.length < 20)) continue;
        element.setAttribute(ITEM_KEY_ATTR, candidate.itemKey);
        const signature = createSignature(candidate);
        const cached = decisionCache.get(candidate.itemKey);
        const shouldRefreshForOllama = cached
          && cached.hardAiSynthetic !== true
          && cached.transcriptChecked !== true
          && hasTranscriptForOllama(candidate);
        const detectorAge = Date.now() - Number(cached?.detectorCheckedAt || 0);
        const shouldRefreshForDetector = cached
          && cached.hardAiSynthetic !== true
          && ((cached.detectorStatus === "pending" && detectorAge >= 4000)
            || (cached.detectorStatus === "unavailable" && detectorAge >= 30000));
        if (cached && !shouldRefreshForOllama && !shouldRefreshForDetector) {
          applyDecision(element, candidate, cached);
          element.setAttribute(PROCESSED_ATTR, "true");
          element.setAttribute(SIGNATURE_ATTR, signature);
          continue;
        }
        if (element.getAttribute(SIGNATURE_ATTR) === signature) continue;
        element.setAttribute(PROCESSED_ATTR, "true");
        element.setAttribute(SIGNATURE_ATTR, signature);
        jobs.push({ element, candidate });
      }

      const results = await scoreCandidates(jobs.map((job) => job.candidate));
      for (let index = 0; index < jobs.length; index += 1) {
        const { element, candidate } = jobs[index];
        if (!element.isConnected || decisionCache.isAllowed(candidate.itemKey)) continue;
        const decision = results[index] || scoreOneCandidate(candidate);
        const stableDecision = {
          ...decision,
          transcriptChecked: hasTranscriptForOllama(candidate),
          detectorCheckedAt: Date.now()
        };
        decisionCache.set(candidate.itemKey, stableDecision);
        applyDecision(element, candidate, stableDecision);
        if (stableDecision.detectorStatus === "pending") window.setTimeout(scheduleScan, 5000);
        if (stableDecision.detectorStatus === "unavailable") window.setTimeout(scheduleScan, 30000);
      }
    } finally {
      scanInFlight = false;
      if (scanQueued) {
        scanQueued = false;
        scheduleScan();
      }
    }
  }

  function syncLocation() {
    if (window.location.href === lastHref) return;
    lastHref = window.location.href;
    for (const element of document.querySelectorAll(".orislop-current-item-hidden")) {
      element.classList.remove("orislop-skip-hidden", "orislop-current-item-hidden");
    }
    for (const cover of document.querySelectorAll(".orislop-decision-cover")) cover.remove();
    for (const host of document.querySelectorAll(".orislop-decision-host")) host.classList.remove("orislop-decision-host");
    resetProcessedState();
  }

  function findLookaheadCandidates() {
    const platform = currentPlatform();
    let selectors = [];
    if (platform === "youtube") {
      selectors = [
        "ytd-rich-item-renderer",
        "ytd-video-renderer",
        "ytd-grid-video-renderer",
        "ytd-compact-video-renderer",
        "ytd-playlist-panel-video-renderer",
        "ytd-reel-item-renderer",
        "ytd-reel-video-renderer",
        "yt-lockup-view-model",
        "ytm-rich-item-renderer",
        "ytm-video-with-context-renderer",
        "ytm-shorts-lockup-view-model",
        "ytd-watch-metadata"
      ];
    } else if (platform === "instagram") {
      selectors = ["main article", "article"];
    } else if (platform === "tiktok") {
      selectors = [
        "div[data-e2e='recommend-list-item-container']",
        "div[data-e2e='feed-item']",
        "div[data-e2e='browse-video']",
        "article[data-e2e]"
      ];
    }

    const all = Array.from(document.querySelectorAll(selectors.join(",")))
      .filter((element) => element instanceof HTMLElement)
      .filter(isPlatformCandidate)
      .filter((element) => !Array.from(element.parentElement?.closest?.(selectors.join(",")) ? [1] : []).length)
      .filter((element) => !element.classList.contains("orislop-skip-hidden") && isInLookaheadRange(element));
    const unique = [];
    const seen = new Set();
    for (const element of all) {
      const candidate = extractCandidate(element);
      const key = candidate.itemKey || `node:${unique.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({ element, candidate });
    }
    const current = unique.filter(({ element, candidate }) => isCurrentCandidate(element, candidate));
    const nearby = unique
      .filter(({ element, candidate }) => !isCurrentCandidate(element, candidate))
      .sort((left, right) => left.element.getBoundingClientRect().top - right.element.getBoundingClientRect().top);
    return [...current, ...nearby].slice(0, LOOKAHEAD_LIMIT).map(({ element }) => element);
  }

  function isPlatformCandidate(element) {
    const platform = currentPlatform();
    if (platform === "instagram") {
      return Boolean(element.querySelector("a[href*='/reel/'], a[href*='/p/'], video"));
    }
    if (platform === "tiktok") return Boolean(element.querySelector("a[href*='/video/'], video"));
    return true;
  }

  function isInLookaheadRange(element) {
    const rect = element.getBoundingClientRect();
    return rect.width > 40 && rect.height > 30 && rect.bottom >= -500 && rect.top <= window.innerHeight + 5000;
  }

  function extractCandidate(element) {
    const platform = currentPlatform();
    const link = findItemLink(element, platform);
    const fallbackUrl = isLikelyCurrentElement(element) ? window.location.href : "";
    const parsed = OrislopClassifier.parsePlatformUrl(link || fallbackUrl, platform, element.dataset.videoId || element.getAttribute("data-video-id") || "");
    const title = findTitle(element, platform);
    const channelName = findCreator(element, platform);
    const visibleText = collectScopedText(element, platform, title, channelName);
    const transcriptText = collectTranscriptText(element, platform);
    const mediaUrl = findMediaUrl(element);
    const itemId = parsed.itemId || stableHash([link, title, channelName].join("|"));
    const itemKey = `${platform}:${itemId}`;
    return {
      platform,
      itemId,
      itemKey,
      url: parsed.normalizedUrl || link || fallbackUrl || window.location.href,
      title,
      channelName,
      visibleText,
      transcriptText,
      mediaUrl,
      durationSeconds: findDurationSeconds(element),
      itemKind: parsed.itemKind
    };
  }

  function findMediaUrl(element) {
    const localVideo = element.querySelector("video");
    const currentVideo = isLikelyCurrentElement(element) ? document.querySelector("video") : null;
    const value = cleanText(localVideo?.currentSrc || currentVideo?.currentSrc || "", 4000);
    return /^https:\/\//i.test(value) ? value : "";
  }

  function findItemLink(element, platform) {
    const anchors = Array.from(element.querySelectorAll("a[href]"));
    const anchor = anchors.find((item) => {
      const href = item.getAttribute("href") || "";
      if (platform === "youtube") return href.includes("/watch?v=") || href.includes("/shorts/");
      if (platform === "instagram") return href.includes("/reel/") || href.includes("/p/");
      if (platform === "tiktok") return href.includes("/video/");
      return false;
    });
    if (!anchor) return "";
    try {
      return new URL(anchor.getAttribute("href") || "", window.location.origin).href;
    } catch {
      return "";
    }
  }

  function findTitle(element, platform) {
    const selectors = platform === "youtube"
      ? ["#video-title", "yt-formatted-string#video-title", "yt-shorts-video-title-view-model h2", "h1", "h2", "h3", "a[title]", "[aria-label][role='link']"]
      : platform === "instagram"
        ? ["h1", "span[dir='auto']", "div[role='button'] span"]
        : ["[data-e2e='browse-video-desc']", "[data-e2e='video-desc']", "h1"];
    for (const selector of selectors) {
      const node = element.querySelector(selector);
      const text = cleanText(node?.getAttribute?.("title") || node?.textContent || "", 400);
      if (text.length >= 2) return text;
    }
    return cleanText(element.getAttribute("aria-label") || "", 400);
  }

  function findCreator(element, platform) {
    const selectors = platform === "youtube"
      ? ["#channel-name", "ytd-channel-name", "a[href^='/@']", ".ytd-channel-name"]
      : platform === "instagram"
        ? ["header a[role='link']", "a[href^='/'][role='link']"]
        : ["[data-e2e='video-author-uniqueid']", "[data-e2e='browse-username']", "a[href^='/@']"];
    for (const selector of selectors) {
      const node = element.querySelector(selector);
      const text = cleanText(node?.textContent || node?.getAttribute?.("aria-label") || "", 240);
      if (text) return text;
    }
    return "";
  }

  function collectScopedText(element, platform, title, channelName) {
    const selectors = platform === "youtube"
      ? ["#description", "#metadata-line", "yt-formatted-string#video-title", "yt-shorts-video-title-view-model", "ytd-channel-name", "ytd-badge-supported-renderer", "[aria-label*='synthetic']", "[aria-label*='AI']"]
      : platform === "instagram"
        ? ["span[dir='auto']", "h1", "[aria-label]"]
        : ["[data-e2e='browse-video-desc']", "[data-e2e='video-desc']", "[data-e2e='video-music']", "[data-e2e='browse-music']"];
    const pieces = [title, channelName];
    for (const node of Array.from(element.querySelectorAll(selectors.join(","))).slice(0, 24)) {
      if (!(node instanceof HTMLElement)) continue;
      const text = cleanText([node.textContent, node.getAttribute("aria-label"), node.getAttribute("title")].filter(Boolean).join(" "), 500);
      if (text) pieces.push(text);
    }
    return cleanText(Array.from(new Set(pieces)).join(" "), 1800);
  }

  function collectTranscriptText(element, platform) {
    const selectors = platform === "youtube"
      ? [".ytp-caption-segment", "ytd-transcript-segment-renderer .segment-text", "yt-formatted-string.ytd-transcript-segment-renderer"]
      : platform === "instagram"
        ? ["span[dir='auto']"]
        : ["[data-e2e='browse-video-desc']", "[data-e2e='video-desc']"];
    const local = Array.from(element.querySelectorAll(selectors.join(","))).slice(0, 30);
    const globalCurrent = isLikelyCurrentElement(element) && platform === "youtube"
      ? Array.from(document.querySelectorAll(".ytp-caption-segment")).slice(0, 20)
      : [];
    return cleanText([...local, ...globalCurrent].map((node) => node.textContent || "").join(" "), 1800);
  }

  function findDurationSeconds(element) {
    const node = element.querySelector("ytd-thumbnail-overlay-time-status-renderer, .badge-shape-wiz__text, [aria-label*='minute'], [aria-label*='second']");
    const value = cleanText(node?.textContent || node?.getAttribute?.("aria-label") || "", 80);
    const clock = value.match(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/);
    if (clock) return Number(clock[1] || 0) * 3600 + Number(clock[2] || 0) * 60 + Number(clock[3] || 0);
    return null;
  }

  function createSignature(candidate) {
    return stableHash([candidate.itemKey, candidate.title, candidate.channelName, candidate.visibleText, candidate.transcriptText].join("|"));
  }

  async function scoreCandidates(candidates) {
    if (candidates.length === 0) return [];
    const results = candidates.map(scoreOneCandidate);
    const ollamaJobs = candidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ index }) => results[index].hardAiSynthetic !== true);
    if (ollamaJobs.length === 0) return results;
    try {
      const response = await sendRuntimeMessage({
        type: "orislop.scoreBatch",
        candidates: ollamaJobs.map(({ candidate }) => candidate).slice(0, LOOKAHEAD_LIMIT),
        settings: {
          ollamaModel: settingsCache.ollamaModel
        }
      }, OLLAMA_RESPONSE_TIMEOUT_MS);
      if (!response?.ok || !Array.isArray(response.results)) throw new Error(response?.error || "Background scoring unavailable");
      void chrome.storage.local.set({
        [OLLAMA_STATUS_KEY]: {
          state: response.ollamaStatus || "unavailable",
          error: response.ollamaError || "",
          model: response.model || settingsCache.ollamaModel,
          checkedAt: new Date().toISOString()
        },
        [DETECTOR_STATUS_KEY]: {
          state: response.detectorStatus || "unavailable",
          error: response.detectorError || "",
          spatialModel: "gonnerthetooner/orislop-fusion",
          temporalModel: "gonnerthetooner/deepfake-temporal-moe",
          checkedAt: new Date().toISOString()
        }
      });
      for (let index = 0; index < ollamaJobs.length; index += 1) {
        results[ollamaJobs[index].index] = response.results[index] || results[ollamaJobs[index].index];
      }
      return results;
    } catch (error) {
      void chrome.storage.local.set({
        [OLLAMA_STATUS_KEY]: {
          state: "unavailable",
          error: error instanceof Error ? error.message : String(error),
          model: settingsCache.ollamaModel,
          checkedAt: new Date().toISOString()
        },
        [DETECTOR_STATUS_KEY]: {
          state: "unavailable",
          error: error instanceof Error ? error.message : String(error),
          spatialModel: "gonnerthetooner/orislop-fusion",
          temporalModel: "gonnerthetooner/deepfake-temporal-moe",
          checkedAt: new Date().toISOString()
        }
      });
      return results;
    }
  }

  function sendRuntimeMessage(message, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Required Ollama scoring timed out"));
      }, timeoutMs);
      chrome.runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(response);
      });
    });
  }

  function scoreOneCandidate(candidate) {
    return OrislopClassifier.scoreCandidate(candidate);
  }

  function hasTranscriptForOllama(candidate) {
    const text = [
      candidate.transcriptText,
      candidate.platform === "youtube" ? "" : candidate.visibleText
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    return text.length >= 36;
  }

  function applyDecision(element, candidate, decision) {
    if (decision.recommendation !== "skip" || decisionCache.isAllowed(candidate.itemKey)) {
      clearDecisionUi(element, candidate.itemKey);
      return;
    }

    void saveFlaggedRecord(candidate, decision);
    if (isCurrentCandidate(element, candidate)) {
      showDecisionCover(element, candidate, decision);
    } else if (settingsCache.hideSkipped) {
      hideElement(element, candidate, decision, false);
    } else {
      showDecisionCover(element, candidate, decision);
    }
  }

  function showDecisionCover(element, candidate, decision) {
    const host = findMediaHost(element, candidate);
    if (!(host instanceof HTMLElement)) return;
    const existing = host.querySelector(":scope > .orislop-decision-cover");
    if (existing?.dataset.itemKey === candidate.itemKey) return;
    existing?.remove();
    host.classList.add("orislop-decision-host");

    const cover = document.createElement("section");
    cover.className = "orislop-decision-cover";
    cover.dataset.itemKey = candidate.itemKey;
    cover.setAttribute("role", "dialog");
    cover.setAttribute("aria-label", "Orislop skip decision");

    const verdict = document.createElement("strong");
    verdict.textContent = "Orislop: Skip";
    const title = document.createElement("p");
    title.textContent = candidate.title || `${capitalize(candidate.platform)} video`;
    const reason = document.createElement("small");
    reason.textContent = `${decision.score}/100 · ${decision.reasons.slice(0, 2).join(" · ")}`;
    const actions = document.createElement("div");
    const keepButton = document.createElement("button");
    keepButton.type = "button";
    keepButton.textContent = "Don't skip";
    keepButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      decisionCache.allow(candidate.itemKey);
      element.setAttribute(PROCESSED_ATTR, "allowed");
      clearDecisionUi(element, candidate.itemKey);
      element.classList.remove("orislop-skip-hidden", "orislop-current-item-hidden");
    });
    const skipButton = document.createElement("button");
    skipButton.type = "button";
    skipButton.textContent = "Skip";
    skipButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      cover.remove();
      hideElement(element, candidate, decision, true);
    });
    actions.append(keepButton, skipButton);
    cover.append(verdict, title, reason, actions);
    host.prepend(cover);
  }

  function findMediaHost(element, candidate) {
    if (isCurrentCandidate(element, candidate) && candidate.platform === "youtube" && window.location.pathname === "/watch") {
      return document.querySelector("#movie_player, ytd-player") || element;
    }
    const video = element.querySelector("video");
    if (video?.parentElement instanceof HTMLElement) return video.parentElement;
    return element.querySelector("#shorts-player, #player-container, ytd-player, [data-e2e='video-player']") || element;
  }

  function hideElement(element, candidate, decision, explicit) {
    clearDecisionUi(element, candidate.itemKey);
    const target = isCurrentCandidate(element, candidate) && candidate.platform === "youtube" && window.location.pathname === "/watch"
      ? findMediaHost(element, candidate)
      : element;
    if (!(target instanceof HTMLElement)) return;
    target.classList.add("orislop-skip-hidden");
    target.dataset.orislopAutoHidden = explicit ? "false" : "true";
    if (isCurrentCandidate(element, candidate)) target.classList.add("orislop-current-item-hidden");
    for (const video of target.querySelectorAll("video")) video.pause?.();
    void saveSkippedRecord(candidate, decision, explicit ? "user_skip" : "hidden_before_view");
  }

  function clearDecisionUi(element, itemKey) {
    for (const cover of document.querySelectorAll(".orislop-decision-cover")) {
      if (!itemKey || cover.dataset.itemKey === itemKey) {
        const host = cover.parentElement;
        cover.remove();
        if (host && !host.querySelector(":scope > .orislop-decision-cover")) host.classList.remove("orislop-decision-host");
      }
    }
    if (element.classList.contains("orislop-decision-host") && !element.querySelector(":scope > .orislop-decision-cover")) {
      element.classList.remove("orislop-decision-host");
    }
  }

  function restoreAutomaticallyHiddenItems() {
    for (const element of document.querySelectorAll(".orislop-skip-hidden[data-orislop-auto-hidden='true']")) {
      element.classList.remove("orislop-skip-hidden", "orislop-current-item-hidden");
      delete element.dataset.orislopAutoHidden;
      element.removeAttribute(PROCESSED_ATTR);
      element.removeAttribute(SIGNATURE_ATTR);
    }
  }

  function resetProcessedState() {
    for (const element of document.querySelectorAll(`[${PROCESSED_ATTR}], [${SIGNATURE_ATTR}]`)) {
      if (element.getAttribute(PROCESSED_ATTR) === "allowed") continue;
      element.removeAttribute(PROCESSED_ATTR);
      element.removeAttribute(SIGNATURE_ATTR);
    }
  }

  function isCurrentCandidate(element, candidate) {
    const current = OrislopClassifier.parsePlatformUrl(window.location.href, currentPlatform());
    if (current.itemId && candidate.itemId === current.itemId) return true;
    return isLikelyCurrentElement(element);
  }

  function isLikelyCurrentElement(element) {
    if (element.matches("ytd-watch-metadata")) return window.location.pathname === "/watch";
    const rect = element.getBoundingClientRect();
    const center = rect.top + rect.height / 2;
    return Boolean(element.querySelector("video")) && rect.height >= window.innerHeight * 0.55 && Math.abs(center - window.innerHeight / 2) < window.innerHeight * 0.32;
  }

  async function saveFlaggedRecord(candidate, decision) {
    if (!historyWriter) return;
    const id = `${candidate.itemKey}:skip`;
    await historyWriter.append(FLAGGED_KEY, {
      id,
      itemKey: candidate.itemKey,
      itemId: candidate.itemId,
      platform: candidate.platform,
      url: candidate.url,
      title: candidate.title || `${capitalize(candidate.platform)} video`,
      recommendation: "skip",
      score: decision.score,
      reasons: decision.reasons,
      createdAt: new Date().toISOString()
    }, (record) => record.id || `${record.itemKey}:skip`);
  }

  async function saveSkippedRecord(candidate, decision, mode) {
    if (!historyWriter) return;
    const id = `${candidate.itemKey}:${mode}`;
    if (loggedSkipKeys.has(id)) return;
    loggedSkipKeys.add(id);
    await historyWriter.append(SKIPPED_KEY, {
      id,
      itemKey: candidate.itemKey,
      itemId: candidate.itemId,
      platform: candidate.platform,
      url: candidate.url,
      title: candidate.title || `${capitalize(candidate.platform)} video`,
      mode,
      score: decision.score,
      reasons: decision.reasons,
      createdAt: new Date().toISOString()
    }, (record) => record.id || `${record.itemKey}:${record.mode}`);
  }

  async function loadSettings() {
    try {
      const result = await chrome.storage.local.get(SETTINGS_KEY);
      return normalizeSettings(result[SETTINGS_KEY]);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function normalizeSettings(value) {
    if (!value || typeof value !== "object") return { ...DEFAULT_SETTINGS };
    return {
      hideSkipped: typeof value.hideSkipped === "boolean"
        ? value.hideSkipped
        : typeof value.hideFeedCards === "boolean" ? value.hideFeedCards : DEFAULT_SETTINGS.hideSkipped,
      ollamaModel: /^[a-zA-Z0-9._:/-]{1,100}$/.test(String(value.ollamaModel || "")) ? String(value.ollamaModel) : DEFAULT_SETTINGS.ollamaModel
    };
  }

  async function readList(key) {
    try {
      const result = await chrome.storage.local.get(key);
      return Array.isArray(result[key]) ? result[key] : [];
    } catch {
      return [];
    }
  }

  function currentPlatform() {
    const host = window.location.hostname.toLowerCase();
    if (host.endsWith("youtube.com")) return "youtube";
    if (host.endsWith("instagram.com")) return "instagram";
    if (host.endsWith("tiktok.com")) return "tiktok";
    return "unknown";
  }

  function stableHash(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `generated-${(hash >>> 0).toString(36)}`;
  }

  function cleanText(value, limit) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
  }

  function capitalize(value) {
    return value ? `${value[0].toUpperCase()}${value.slice(1)}` : "Video";
  }
})();
