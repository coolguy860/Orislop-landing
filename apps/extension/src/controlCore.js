(() => {
  "use strict";

  function evaluateAutoSkip({
    recommendation,
    autoSkip,
    videoId,
    pendingVideoId = null,
    suppressedVideoIds = new Set(),
    skippedVideoIds = new Set(),
    consecutiveSkipCount = 0,
    maxConsecutiveSkips = 3,
    paused = false
  }) {
    if (recommendation !== "skip") {
      return { allowed: false, reason: "not_skip" };
    }
    if (!autoSkip) {
      return { allowed: false, reason: "disabled" };
    }
    if (!videoId) {
      return { allowed: false, reason: "missing_video" };
    }
    if (suppressedVideoIds.has(videoId)) {
      return { allowed: false, reason: "suppressed" };
    }
    if (skippedVideoIds.has(videoId)) {
      return { allowed: false, reason: "revisit" };
    }
    if (pendingVideoId === videoId) {
      return { allowed: false, reason: "pending" };
    }
    if (paused || consecutiveSkipCount >= maxConsecutiveSkips) {
      return { allowed: false, reason: "max_consecutive" };
    }
    return { allowed: true, reason: "allowed" };
  }

  function createSkipController({
    getCurrentVideoId,
    setTimer = globalThis.setTimeout.bind(globalThis),
    clearTimer = globalThis.clearTimeout.bind(globalThis),
    retryDelays = [140, 650, 1300],
    maxConsecutiveSkips = 3,
    onStateChange = () => {}
  }) {
    const suppressedVideoIds = new Set();
    const skippedVideoIds = new Set();
    let pending = null;
    let consecutiveSkipCount = 0;
    let paused = false;

    function state() {
      return {
        pendingVideoId: pending?.videoId || null,
        consecutiveSkipCount,
        maxConsecutiveSkips,
        paused,
        suppressedVideoIds: new Set(suppressedVideoIds),
        skippedVideoIds: new Set(skippedVideoIds)
      };
    }

    function emit(type, details = {}) {
      onStateChange({ type, ...details, state: state() });
    }

    function evaluate(input) {
      const result = evaluateAutoSkip({
        ...input,
        pendingVideoId: pending?.videoId || null,
        suppressedVideoIds,
        skippedVideoIds,
        consecutiveSkipCount,
        maxConsecutiveSkips,
        paused
      });
      if (result.reason === "max_consecutive") {
        paused = true;
      }
      return result;
    }

    function finishPending(reason) {
      const operation = pending;
      if (!operation) {
        return;
      }
      for (const timerId of operation.timerIds) {
        clearTimer(timerId);
      }
      operation.timerIds.clear();
      pending = null;
      emit("navigation_stopped", { videoId: operation.videoId, reason });
    }

    function scheduleAttempt(operation, attemptIndex) {
      if (pending !== operation) {
        return;
      }
      if (attemptIndex >= retryDelays.length) {
        finishPending("navigation_failed");
        return;
      }

      const timerId = setTimer(async () => {
        operation.timerIds.delete(timerId);
        if (pending !== operation) {
          return;
        }
        if (getCurrentVideoId() !== operation.videoId) {
          finishPending("video_changed");
          return;
        }

        let succeeded = false;
        try {
          succeeded = (await operation.attempt({
            videoId: operation.videoId,
            attemptIndex
          })) === true;
        } catch {
          succeeded = false;
        }

        if (pending !== operation) {
          return;
        }
        if (succeeded) {
          finishPending("navigation_started");
          return;
        }
        if (getCurrentVideoId() !== operation.videoId) {
          finishPending("video_changed");
          return;
        }
        scheduleAttempt(operation, attemptIndex + 1);
      }, Math.max(0, retryDelays[attemptIndex] || 0));
      operation.timerIds.add(timerId);
    }

    function start({ recommendation, autoSkip, videoId, attempt }) {
      const decision = evaluate({ recommendation, autoSkip, videoId });
      if (!decision.allowed) {
        emit("skip_blocked", { videoId, reason: decision.reason });
        return decision;
      }

      if (pending) {
        finishPending("replaced");
      }
      skippedVideoIds.add(videoId);
      consecutiveSkipCount += 1;
      const operation = {
        videoId,
        attempt,
        timerIds: new Set()
      };
      pending = operation;
      emit("skip_started", { videoId });
      scheduleAttempt(operation, 0);
      return { allowed: true, reason: "started" };
    }

    function cancel({ videoId = pending?.videoId || null, suppress = false, reason = "cancelled" } = {}) {
      if (suppress && videoId) {
        suppressedVideoIds.add(videoId);
      }
      if (pending && (!videoId || pending.videoId === videoId)) {
        finishPending(reason);
      }
      emit("skip_cancelled", { videoId, reason, suppress });
    }

    function notifyVideoChange(videoId) {
      if (pending && pending.videoId !== videoId) {
        finishPending("video_changed");
      }
    }

    function noteNonSkipVerdict(videoId) {
      if (!videoId || getCurrentVideoId() !== videoId) {
        return;
      }
      if (consecutiveSkipCount > 0 || paused) {
        consecutiveSkipCount = 0;
        paused = false;
        emit("consecutive_reset", { videoId });
      }
    }

    function resume() {
      consecutiveSkipCount = 0;
      paused = false;
      emit("skip_resumed");
    }

    function clearPending(reason = "cancelled") {
      if (pending) {
        finishPending(reason);
      }
    }

    return {
      cancel,
      clearPending,
      evaluate,
      getState: state,
      noteNonSkipVerdict,
      notifyVideoChange,
      resume,
      start
    };
  }

  function createHistoryWriter({ readList, writeList, limit = 300 }) {
    const queues = new Map();

    function append(key, records, keyFor) {
      const additions = Array.isArray(records) ? records : [records];
      const previous = queues.get(key) || Promise.resolve();
      const operation = previous
        .catch(() => {})
        .then(async () => {
          const current = await readList(key);
          const seen = new Set();
          const merged = [];
          for (const record of [...additions, ...current]) {
            const recordKey = keyFor(record);
            if (seen.has(recordKey)) {
              continue;
            }
            seen.add(recordKey);
            merged.push(record);
            if (merged.length >= limit) {
              break;
            }
          }
          await writeList(key, merged);
          return merged;
        });
      queues.set(key, operation);
      const cleanup = () => {
        if (queues.get(key) === operation) {
          queues.delete(key);
        }
      };
      void operation.then(cleanup, cleanup);
      return operation;
    }

    async function flush() {
      await Promise.all(Array.from(queues.values()).map((operation) => operation.catch(() => {})));
    }

    return { append, flush };
  }

  globalThis.OrislopExtensionCore = Object.freeze({
    createHistoryWriter,
    createSkipController,
    evaluateAutoSkip
  });
})();
