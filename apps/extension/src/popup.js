const FLAGGED_KEY = "orislop.extension.flaggedLog";
const SKIPPED_KEY = "orislop.extension.skippedLog";
const SETTINGS_KEY = "orislop.extension.settings";
const OLLAMA_STATUS_KEY = "orislop.extension.ollamaStatus";
const DETECTOR_STATUS_KEY = "orislop.extension.detectorStatus";
const DEFAULT_SETTINGS = { hideSkipped: true, ollamaModel: "qwen2.5:1.5b-instruct" };
const storage = createStorageAdapter();
let pendingClear = "";

void render();

async function render() {
  const [flagged, skipped, settings, ollamaStatus, detectorStatus] = await Promise.all([
    readList(FLAGGED_KEY),
    readList(SKIPPED_KEY),
    readSettings(),
    storage.get(OLLAMA_STATUS_KEY),
    storage.get(DETECTOR_STATUS_KEY)
  ]);
  document.getElementById("flaggedCount").textContent = String(flagged.length);
  document.getElementById("skippedCount").textContent = String(skipped.length);
  setToggle("hideSkippedToggle", settings.hideSkipped);
  document.getElementById("ollamaModel").value = settings.ollamaModel;
  renderSkippedList(skipped);
  renderOllamaStatus(settings, ollamaStatus[OLLAMA_STATUS_KEY]);
  renderDetectorStatus(detectorStatus[DETECTOR_STATUS_KEY]);
}

async function readList(key) {
  const result = await storage.get(key);
  return Array.isArray(result[key]) ? result[key] : [];
}

async function readSettings() {
  const result = await storage.get(SETTINGS_KEY);
  return normalizeSettings(result[SETTINGS_KEY]);
}

function normalizeSettings(value) {
  if (!value || typeof value !== "object") return { ...DEFAULT_SETTINGS };
  return {
    hideSkipped: typeof value.hideSkipped === "boolean" ? value.hideSkipped : typeof value.hideFeedCards === "boolean" ? value.hideFeedCards : true,
    ollamaModel: /^[a-zA-Z0-9._:/-]{1,100}$/.test(String(value.ollamaModel || "")) ? String(value.ollamaModel) : DEFAULT_SETTINGS.ollamaModel
  };
}

async function saveSettings(settings) {
  await storage.set({ [SETTINGS_KEY]: normalizeSettings(settings) });
}

function setToggle(id, checked) {
  const element = document.getElementById(id);
  element.checked = checked;
  element.setAttribute("aria-checked", String(checked));
}

function renderSkippedList(records) {
  const host = document.getElementById("skippedList");
  host.innerHTML = "";
  if (records.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No hidden videos yet.";
    host.append(empty);
    return;
  }
  for (const record of records.slice(0, 8)) {
    const item = document.createElement("article");
    item.className = "skipped-item";
    const title = document.createElement("strong");
    title.textContent = record.title || "Video";
    const detail = document.createElement("span");
    detail.textContent = `${record.platform || "feed"} - ${record.mode === "user_skip" ? "Skip" : "Hidden before view"} - ${record.score}/100`;
    item.append(title, detail);
    host.append(item);
  }
}

function renderOllamaStatus(settings, status) {
  const host = document.getElementById("ollamaStatus");
  const state = status?.state || "not_tested";
  host.dataset.state = state;
  if (state === "available") {
    host.textContent = `${status.model || settings.ollamaModel} is the active required classifier.`;
  } else if (state === "bypassed_hard_ai") {
    host.textContent = "AI/synthetic content was skipped by the 100/100 hard rule.";
  } else {
    host.textContent = status?.error || "Ollama is required. Open a supported feed or press Test.";
  }
}

function renderDetectorStatus(status) {
  const host = document.getElementById("detectorStatus");
  const state = status?.state || "not_tested";
  host.dataset.state = state;
  if (state === "available") {
    host.textContent = "Spatial and temporal model results are ready.";
  } else if (state === "pending") {
    host.textContent = "Visual scan queued locally. The first model load can take several minutes.";
  } else if (state === "bypassed_hard_ai") {
    host.textContent = "The explicit AI/synthetic hard rule made a detector scan unnecessary.";
  } else {
    host.textContent = status?.error || "Start the required detector bridge, then press Test.";
  }
}

document.getElementById("hideSkippedToggle").addEventListener("change", async (event) => {
  const settings = await readSettings();
  await saveSettings({ ...settings, hideSkipped: event.target.checked });
  setStatus(event.target.checked ? "Skip-rated feed items will be hidden." : "Automatic hiding is off; current covers still offer Don't skip / Skip.");
  await render();
});

document.getElementById("ollamaModel").addEventListener("change", async () => {
  const settings = await readSettings();
  await saveSettings({ ...settings, ollamaModel: readModelInput() });
  setStatus("Required Ollama model saved. New items will use it immediately.");
  await render();
});

document.getElementById("testOllamaButton").addEventListener("click", testOllama);
document.getElementById("testDetectorButton").addEventListener("click", testDetector);

async function testOllama() {
  if (!storage.isExtensionStorage || !chrome.runtime?.sendMessage) {
    setStatus("Load the extension in Chrome to test Ollama.");
    return;
  }
  setStatus("Testing required Ollama service...");
  const response = await sendMessage({ type: "orislop.testOllama", model: readModelInput() });
  setStatus(response?.message || response?.error || "Ollama test failed.");
}

async function testDetector() {
  if (!storage.isExtensionStorage || !chrome.runtime?.sendMessage) {
    setStatus("Load the extension in Chrome to test the detector bridge.");
    return;
  }
  setStatus("Testing required spatial and temporal detector bridge...");
  const response = await sendMessage({ type: "orislop.testDetector" });
  setStatus(response?.message || response?.error || "Detector bridge test failed.");
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : response));
  });
}

function readModelInput() {
  const value = document.getElementById("ollamaModel").value.trim();
  return /^[a-zA-Z0-9._:/-]{1,100}$/.test(value) ? value : DEFAULT_SETTINGS.ollamaModel;
}

document.getElementById("clearSkippedButton").addEventListener("click", () => requestClear("skipped"));
document.getElementById("clearAllDataButton").addEventListener("click", () => requestClear("all"));
document.getElementById("cancelClearButton").addEventListener("click", closeClear);
document.getElementById("confirmClearButton").addEventListener("click", async () => {
  const action = pendingClear;
  await storage.remove(action === "all" ? [FLAGGED_KEY, SKIPPED_KEY, OLLAMA_STATUS_KEY, DETECTOR_STATUS_KEY] : [SKIPPED_KEY]);
  closeClear();
  setStatus(action === "all" ? "Local Orislop data cleared." : "Hidden-video history cleared.");
  await render();
});

function requestClear(action) {
  pendingClear = action;
  document.getElementById("clearConfirmation").hidden = false;
  document.getElementById("confirmClearButton").focus();
}

function closeClear() {
  pendingClear = "";
  document.getElementById("clearConfirmation").hidden = true;
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && pendingClear) closeClear();
});

function setStatus(message) {
  document.getElementById("popupStatus").textContent = message;
}

function createStorageAdapter() {
  const isExtensionStorage = Boolean(globalThis.chrome?.storage?.local);
  if (isExtensionStorage) {
    return {
      isExtensionStorage: true,
      get: (keys) => chrome.storage.local.get(keys),
      set: (value) => chrome.storage.local.set(value),
      remove: (keys) => chrome.storage.local.remove(keys)
    };
  }
  return {
    isExtensionStorage: false,
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.map((key) => [key, JSON.parse(localStorage.getItem(key) || "null")]));
    },
    async set(value) {
      for (const [key, item] of Object.entries(value)) localStorage.setItem(key, JSON.stringify(item));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) localStorage.removeItem(key);
    }
  };
}
