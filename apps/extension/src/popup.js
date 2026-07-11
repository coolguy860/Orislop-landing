const FLAGGED_KEY = "orislop.extension.flaggedLog";
const SKIPPED_KEY = "orislop.extension.skippedLog";
const SETTINGS_KEY = "orislop.extension.settings";
const DEFAULT_SETTINGS = {
  autoSkip: false,
  hideFeedCards: true,
  hideBotComments: false,
  advancedDetection: false
};
const PREVIEW_FLAGGED_SAMPLE = [{
  title: "Reddit story Minecraft parkour text to speech",
  recommendation: "skip",
  score: 100,
  reasons: ["Stacked slop-format pattern", "Reddit/TTS background-video format"]
}];
const PREVIEW_SKIPPED_SAMPLE = [{
  title: "AI voice viral clips compilation",
  mode: "preview_sample",
  score: 92,
  reasons: ["AI voice or synthetic narration", "Repost or low-originality compilation"]
}, {
  title: "Likely bot comment by promo account",
  mode: "hidden_bot_comment",
  score: 70,
  reasons: ["External contact bait", "Finance or crypto spam"]
}];
const storage = createStorageAdapter();
let pendingClearAction = null;
let clearReturnFocus = null;

async function readList(key) {
  const result = await storage.get(key);
  return Array.isArray(result[key]) ? result[key] : [];
}

async function readSettings() {
  const result = await storage.get(SETTINGS_KEY);
  const value = result[SETTINGS_KEY];
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_SETTINGS };
  }
  return {
    autoSkip: typeof value.autoSkip === "boolean" ? value.autoSkip : DEFAULT_SETTINGS.autoSkip,
    hideFeedCards: typeof value.hideFeedCards === "boolean" ? value.hideFeedCards : DEFAULT_SETTINGS.hideFeedCards,
    hideBotComments: typeof value.hideBotComments === "boolean" ? value.hideBotComments : DEFAULT_SETTINGS.hideBotComments,
    advancedDetection: typeof value.advancedDetection === "boolean" ? value.advancedDetection : DEFAULT_SETTINGS.advancedDetection
  };
}

async function saveSettings(settings) {
  await storage.set({ [SETTINGS_KEY]: settings });
}

async function render() {
  const [flaggedRecords, skippedRecords, settings] = await Promise.all([
    readList(FLAGGED_KEY),
    readList(SKIPPED_KEY),
    readSettings()
  ]);

  document.getElementById("flaggedCount").textContent = String(flaggedRecords.length);
  document.getElementById("skippedCount").textContent = String(skippedRecords.length);
  setToggleState("autoSkipToggle", settings.autoSkip);
  setToggleState("hideFeedCardsToggle", settings.hideFeedCards);
  setToggleState("hideBotCommentsToggle", settings.hideBotComments);
  setToggleState("advancedDetectionToggle", settings.advancedDetection);
  document.getElementById("contextWarning").hidden = storage.isExtensionStorage;
  renderSkippedList(skippedRecords);
  renderFlaggedList(flaggedRecords);
}

function setToggleState(id, checked) {
  const toggle = document.getElementById(id);
  toggle.checked = checked;
  toggle.setAttribute("aria-checked", String(checked));
}

function renderSkippedList(records) {
  const host = document.getElementById("skippedList");
  host.innerHTML = "";
  if (records.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = storage.isExtensionStorage
      ? "No skipped videos yet."
      : "Preview sample only. Installed extension storage is required for real skipped videos.";
    host.append(empty);
    if (!storage.isExtensionStorage) {
      appendSkippedItems(host, PREVIEW_SKIPPED_SAMPLE);
    }
    return;
  }

  appendSkippedItems(host, records.slice(0, 8));
}

function appendSkippedItems(host, records) {
  for (const record of records) {
    const item = document.createElement("article");
    item.className = "skipped-item";
    const title = document.createElement("strong");
    title.textContent = record.title || "YouTube video";
    const detail = document.createElement("span");
    detail.textContent = `${record.mode || "skipped"} - ${record.score}/100 - ${(record.reasons || []).slice(0, 2).join(", ")}`;
    item.append(title, detail);
    host.append(item);
  }
}

function renderFlaggedList(records) {
  const host = document.getElementById("flaggedList");
  host.innerHTML = "";
  if (records.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = storage.isExtensionStorage
      ? "No flagged videos yet."
      : "Preview sample only. Installed extension storage is required for real flagged videos.";
    host.append(empty);
    if (!storage.isExtensionStorage) {
      appendFlaggedItems(host, PREVIEW_FLAGGED_SAMPLE);
    }
    return;
  }

  appendFlaggedItems(host, records.slice(0, 8));
}

function appendFlaggedItems(host, records) {
  for (const record of records) {
    const item = document.createElement("article");
    item.className = "skipped-item";
    const title = document.createElement("strong");
    title.textContent = record.title || "YouTube video";
    const detail = document.createElement("span");
    detail.textContent = `${record.recommendation || "flagged"} - ${record.score}/100 - ${(record.reasons || []).slice(0, 2).join(", ")}`;
    item.append(title, detail);
    host.append(item);
  }
}

document.getElementById("clearLogButton").addEventListener("click", (event) => {
  requestClear("flagged", event.currentTarget);
});

document.getElementById("clearSkippedButton").addEventListener("click", (event) => {
  requestClear("skipped", event.currentTarget);
});

document.getElementById("clearAllDataButton").addEventListener("click", (event) => {
  requestClear("all", event.currentTarget);
});

document.getElementById("confirmClearButton").addEventListener("click", confirmClear);
document.getElementById("cancelClearButton").addEventListener("click", () => closeClearConfirmation("Clear cancelled."));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && pendingClearAction) {
    event.preventDefault();
    closeClearConfirmation("Clear cancelled.");
  }
});

document.getElementById("autoSkipToggle").addEventListener("change", async (event) => {
  const settings = await readSettings();
  await saveSettings({ ...settings, autoSkip: event.target.checked });
  await render();
  setStatus(event.target.checked ? "Auto-skip enabled for Skip verdicts." : "Auto-skip disabled; pending skips will be cancelled.");
});

document.getElementById("hideFeedCardsToggle").addEventListener("change", async (event) => {
  const settings = await readSettings();
  await saveSettings({ ...settings, hideFeedCards: event.target.checked });
  await render();
  setStatus(event.target.checked ? "Feed-card hiding enabled." : "Feed-card hiding disabled; hidden cards will be restored.");
});

document.getElementById("hideBotCommentsToggle").addEventListener("change", async (event) => {
  const settings = await readSettings();
  await saveSettings({ ...settings, hideBotComments: event.target.checked });
  await render();
  setStatus(event.target.checked ? "Likely bot-comment hiding enabled." : "Bot-comment hiding disabled; hidden comments will be restored.");
});

document.getElementById("advancedDetectionToggle").addEventListener("change", async (event) => {
  const settings = await readSettings();
  await saveSettings({ ...settings, advancedDetection: event.target.checked });
  await render();
  setStatus(event.target.checked ? "Advanced detector escalation flag enabled." : "Advanced detector escalation flag disabled.");
});

function requestClear(action, trigger) {
  pendingClearAction = action;
  clearReturnFocus = trigger;
  const labels = {
    flagged: "Clear the flagged history?",
    skipped: "Clear the skipped and hidden history?",
    all: "Clear all histories and reset every setting to its safer default?"
  };
  document.getElementById("clearConfirmationText").textContent = labels[action];
  document.getElementById("clearConfirmation").hidden = false;
  setStatus("Confirmation required before clearing data.");
  document.getElementById("confirmClearButton").focus();
}

async function confirmClear() {
  const action = pendingClearAction;
  if (!action) {
    return;
  }
  const confirmButton = document.getElementById("confirmClearButton");
  confirmButton.disabled = true;
  try {
    if (action === "flagged") {
      await storage.set({ [FLAGGED_KEY]: [] });
    } else if (action === "skipped") {
      await storage.set({ [SKIPPED_KEY]: [] });
    } else {
      await storage.set({
        [FLAGGED_KEY]: [],
        [SKIPPED_KEY]: [],
        [SETTINGS_KEY]: { ...DEFAULT_SETTINGS }
      });
    }
    await render();
    closeClearConfirmation(action === "all" ? "All local Orislop data cleared; safer defaults restored." : `${action === "flagged" ? "Flagged" : "Skipped"} history cleared.`);
  } catch {
    setStatus("Could not clear local data. Please try again.");
  } finally {
    confirmButton.disabled = false;
  }
}

function closeClearConfirmation(message) {
  const returnFocus = clearReturnFocus;
  pendingClearAction = null;
  clearReturnFocus = null;
  document.getElementById("clearConfirmation").hidden = true;
  setStatus(message);
  returnFocus?.focus();
}

function setStatus(message) {
  document.getElementById("popupStatus").textContent = message;
}

void render();

function createStorageAdapter() {
  const extensionStorage = globalThis.chrome?.storage?.local;
  if (extensionStorage) {
    return {
      isExtensionStorage: true,
      get: (key) => extensionStorage.get(key),
      set: (value) => extensionStorage.set(value)
    };
  }

  return {
    isExtensionStorage: false,
    async get(key) {
      try {
        return { [key]: JSON.parse(localStorage.getItem(key) || "null") };
      } catch {
        return { [key]: null };
      }
    },
    async set(value) {
      for (const [key, storedValue] of Object.entries(value)) {
        localStorage.setItem(key, JSON.stringify(storedValue));
      }
    }
  };
}
