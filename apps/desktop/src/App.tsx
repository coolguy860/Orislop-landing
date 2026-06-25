import type {
  ExtractedShort,
  OrislopScoreResult,
  OrislopSettings
} from "../../../packages/shared/src/types.ts";
import type { UserFeedbackAction } from "../../../packages/storage/src/types.ts";
import { renderFeedbackPanel } from "./components/FeedbackPanel.tsx";
import { renderMockShortPanel } from "./components/MockShortPanel.tsx";
import { renderOrislopOverlay } from "./components/OrislopOverlay.tsx";
import { renderSettingsPanel } from "./components/SettingsPanel.tsx";
import { renderShortsWebView } from "./components/ShortsWebView.tsx";
import { renderSkippedBanner } from "./components/SkippedBanner.tsx";
import type { MockShortFixture } from "./mockFixtures.ts";
import {
  attachShortsWebViewNavigationObserver
} from "./youtube/youtubeNavigationObserver.ts";
import {
  getYouTubeShortsExtractorScript
} from "./youtube/youtubeShortsExtractor.ts";
import {
  parseYouTubeShortsUrl,
  YOUTUBE_SHORTS_HOME_URL
} from "./youtube/youtubeUrl.ts";

type ScoreShortResponse = {
  result: OrislopScoreResult;
  cacheHit: boolean;
};

type ScorePayload = {
  fixtureId?: string;
  short?: ExtractedShort;
};

type OrislopApi = {
  listFixtures: () => Promise<MockShortFixture[]>;
  scoreShort: (payload: ScorePayload) => Promise<ScoreShortResponse>;
  scoreExtractedShort: (short: ExtractedShort) => Promise<ScoreShortResponse>;
  getSettings: () => Promise<OrislopSettings>;
  updateSettings: (payload: Partial<OrislopSettings>) => Promise<OrislopSettings>;
  resetSettings: () => Promise<OrislopSettings>;
  saveFeedback: (payload: {
    fixtureId?: string;
    short?: ExtractedShort;
    scoreResult: OrislopScoreResult;
    userFeedback: UserFeedbackAction;
  }) => Promise<unknown>;
  getCachedScore: (payload: ScorePayload) => Promise<OrislopScoreResult | null>;
  getCachedExtractedShort: (short: ExtractedShort) => Promise<OrislopScoreResult | null>;
  clearCache: () => Promise<unknown>;
  forceRescan: (payload: ScorePayload) => Promise<ScoreShortResponse>;
  forceRescanExtractedShort: (short: ExtractedShort) => Promise<ScoreShortResponse>;
  getSkipHistory: () => Promise<unknown[]>;
};

declare global {
  interface Window {
    orislop: OrislopApi;
  }
}

type AppMode = "mock" | "youtube";

type AppState = {
  mode: AppMode;
  fixtures: MockShortFixture[];
  selectedFixtureId: string | null;
  settings: OrislopSettings | null;
  scoreResponse: ScoreShortResponse | null;
  bannerDismissed: boolean;
  status: string;
  skipHistoryCount: number;
  shortsUrl: string;
  extractedShort: ExtractedShort | null;
};

const state: AppState = {
  mode: "mock",
  fixtures: [],
  selectedFixtureId: null,
  settings: null,
  scoreResponse: null,
  bannerDismissed: false,
  status: "Loading mock fixtures.",
  skipHistoryCount: 0,
  shortsUrl: YOUTUBE_SHORTS_HOME_URL,
  extractedShort: null
};

let detachShortsObserver: (() => void) | null = null;
const root = document.getElementById("app");

bootstrap().catch((error: unknown) => {
  state.status = error instanceof Error ? error.message : "Unable to start Orislop Browser.";
  render();
});

async function bootstrap(): Promise<void> {
  state.fixtures = await window.orislop.listFixtures();
  state.selectedFixtureId = state.fixtures[0]?.id ?? null;
  state.settings = await window.orislop.getSettings();
  state.skipHistoryCount = (await window.orislop.getSkipHistory()).length;
  state.status = "Ready.";
  render();
}

function render(): void {
  if (!root) {
    return;
  }

  const fixture = selectedFixture();
  const result = state.scoreResponse?.result ?? null;

  root.innerHTML = `
    <div class="app-shell">
      <header class="app-header">
        <div>
          <h1>Orislop Browser</h1>
          <p>${state.mode === "mock" ? "Mock fixture mode" : "YouTube Shorts mode"}</p>
        </div>
        <span class="app-status">${escapeHtml(state.status)}</span>
      </header>

      ${renderSkippedBanner(result, state.bannerDismissed)}

      <section class="toolbar" aria-label="Fixture and Shorts controls">
        <button type="button" data-action="open-mock-mode" ${state.mode === "mock" ? "disabled" : ""}>Mock fixtures</button>
        <button type="button" data-action="open-youtube-mode" ${state.mode === "youtube" ? "disabled" : ""}>Open YouTube Shorts</button>
        ${state.mode === "mock" ? renderMockToolbar() : renderYouTubeToolbar()}
        <button type="button" data-action="clear-cache">Clear cache</button>
        <span class="history-count">Skip history: ${state.skipHistoryCount}</span>
      </section>

      <div class="content-grid ${state.mode === "youtube" ? "content-grid--youtube" : ""}">
        ${state.mode === "mock"
          ? (fixture ? renderMockShortPanel(fixture) : "<section class=\"panel\">No fixtures found.</section>")
          : renderShortsWebView({
            shortsUrl: state.shortsUrl,
            extractedShort: state.extractedShort,
            webviewReady: true
          })}
        ${renderOrislopOverlay(result, Boolean(state.scoreResponse?.cacheHit))}
        ${renderSettingsPanel(state.settings)}
        ${renderFeedbackPanel(result)}
      </div>
    </div>
  `;

  bindEvents();
}

function renderMockToolbar(): string {
  return `
    <label>
      <span>Fixture</span>
      <select id="fixture-select">
        ${state.fixtures.map((item) => `
          <option value="${item.id}" ${item.id === state.selectedFixtureId ? "selected" : ""}>
            ${escapeHtml(item.label)}
          </option>
        `).join("")}
      </select>
    </label>
    <button type="button" data-action="score">Score fixture</button>
    <button type="button" data-action="force-rescan">Force rescan</button>
  `;
}

function renderYouTubeToolbar(): string {
  return `
    <span class="toolbar-note">Current Short extraction runs after navigation settles or by manual analyze.</span>
    <button type="button" data-action="force-rescan">Force rescan</button>
  `;
}

function bindEvents(): void {
  document.querySelector("[data-action='open-mock-mode']")?.addEventListener("click", () => {
    state.mode = "mock";
    state.scoreResponse = null;
    state.extractedShort = null;
    state.bannerDismissed = false;
    state.status = "Mock fixture mode.";
    render();
  });

  document.querySelector("[data-action='open-youtube-mode']")?.addEventListener("click", () => {
    state.mode = "youtube";
    state.scoreResponse = null;
    state.bannerDismissed = false;
    state.status = "YouTube Shorts mode.";
    render();
  });

  document.getElementById("fixture-select")?.addEventListener("change", (event) => {
    const target = event.target as HTMLSelectElement;
    state.selectedFixtureId = target.value;
    state.scoreResponse = null;
    state.bannerDismissed = false;
    state.status = "Fixture selected.";
    render();
  });

  document.querySelector("[data-action='score']")?.addEventListener("click", () => {
    void scoreSelected(false);
  });
  document.querySelector("[data-action='force-rescan']")?.addEventListener("click", () => {
    void scoreSelected(true);
  });
  document.querySelector("[data-action='clear-cache']")?.addEventListener("click", async () => {
    await window.orislop.clearCache();
    state.status = "Cache cleared.";
    render();
  });
  document.querySelector("[data-action='open-shorts-url']")?.addEventListener("click", () => {
    openShortsUrl();
  });
  document.querySelector("[data-action='analyze-current-short']")?.addEventListener("click", () => {
    void analyzeCurrentShort(true);
  });
  document.querySelector("[data-action='reset-settings']")?.addEventListener("click", async () => {
    state.settings = await window.orislop.resetSettings();
    state.status = "Settings reset.";
    render();
  });

  document.querySelectorAll("[data-setting]").forEach((element) => {
    element.addEventListener("change", (event) => {
      void updateSetting(event.target as HTMLInputElement | HTMLSelectElement);
    });
  });

  document.querySelectorAll("[data-feedback]").forEach((element) => {
    element.addEventListener("click", (event) => {
      const target = event.target as HTMLButtonElement;
      void saveFeedback(target.dataset.feedback as UserFeedbackAction);
    });
  });

  bindShortsObserver();
}

async function scoreSelected(forceRescan: boolean): Promise<void> {
  if (state.mode === "youtube") {
    await analyzeCurrentShort(forceRescan);
    return;
  }

  if (!state.selectedFixtureId) {
    return;
  }

  state.scoreResponse = forceRescan
    ? await window.orislop.forceRescan({ fixtureId: state.selectedFixtureId })
    : await window.orislop.scoreShort({ fixtureId: state.selectedFixtureId });
  state.skipHistoryCount = (await window.orislop.getSkipHistory()).length;
  state.bannerDismissed = false;
  state.status = state.scoreResponse.cacheHit ? "Loaded cached score." : "Scored fixture.";
  render();
}

async function analyzeCurrentShort(forceRescan: boolean): Promise<void> {
  if (state.mode !== "youtube") {
    return;
  }

  const webview = document.getElementById("shorts-webview") as unknown as {
    executeJavaScript?: (script: string, userGesture?: boolean) => Promise<ExtractedShort>;
    getURL?: () => string;
  } | null;

  try {
    const extracted = webview?.executeJavaScript
      ? await webview.executeJavaScript(getYouTubeShortsExtractorScript(), true)
      : fallbackExtractedShort(webview?.getURL?.() ?? state.shortsUrl);

    state.extractedShort = extracted;
    state.shortsUrl = extracted.url;
    state.scoreResponse = forceRescan
      ? await window.orislop.forceRescanExtractedShort(extracted)
      : await window.orislop.scoreExtractedShort(extracted);
    state.skipHistoryCount = (await window.orislop.getSkipHistory()).length;
    state.bannerDismissed = false;
    state.status = state.scoreResponse.cacheHit ? "Loaded cached extracted Short." : "Analyzed current Short.";
  } catch (error) {
    state.status = error instanceof Error ? error.message : "Unable to analyze current Short.";
  }

  render();
}

function openShortsUrl(): void {
  const input = document.getElementById("shorts-url-input") as HTMLInputElement | null;
  const parsed = parseYouTubeShortsUrl(input?.value ?? "");

  if (!parsed.isShortsUrl || !parsed.normalizedUrl) {
    state.status = "Enter a YouTube Shorts URL.";
    render();
    return;
  }

  state.shortsUrl = parsed.normalizedUrl;
  state.extractedShort = null;
  state.scoreResponse = null;
  state.bannerDismissed = false;
  state.status = parsed.videoId ? "Shorts URL loaded." : "Shorts home loaded.";
  render();
}

function bindShortsObserver(): void {
  detachShortsObserver?.();
  detachShortsObserver = null;

  if (state.mode !== "youtube") {
    return;
  }

  const webview = document.getElementById("shorts-webview") as unknown as EventTarget & { getURL?: () => string } | null;
  if (!webview) {
    return;
  }

  detachShortsObserver = attachShortsWebViewNavigationObserver(webview, {
    debounceMs: 800,
    onSettledShortChange: async () => {
      await analyzeCurrentShort(false);
    }
  });
}

async function updateSetting(target: HTMLInputElement | HTMLSelectElement): Promise<void> {
  const key = target.dataset.setting;
  if (!key) {
    return;
  }

  const value = target instanceof HTMLInputElement && target.type === "checkbox"
    ? target.checked
    : target.value;
  state.settings = await window.orislop.updateSettings({ [key]: value });
  state.scoreResponse = null;
  state.status = "Settings saved.";
  render();
}

async function saveFeedback(userFeedback: UserFeedbackAction): Promise<void> {
  if (!state.scoreResponse) {
    return;
  }

  if (state.mode === "mock" && state.selectedFixtureId) {
    await window.orislop.saveFeedback({
      fixtureId: state.selectedFixtureId,
      scoreResult: state.scoreResponse.result,
      userFeedback
    });
  } else if (state.mode === "youtube" && state.extractedShort) {
    await window.orislop.saveFeedback({
      short: state.extractedShort,
      scoreResult: state.scoreResponse.result,
      userFeedback
    });
  }

  if (userFeedback === "watch_anyway" || userFeedback === "show_anyway") {
    state.bannerDismissed = true;
  }

  state.status = "Feedback saved locally.";
  render();
}

function fallbackExtractedShort(url: string): ExtractedShort {
  const parsed = parseYouTubeShortsUrl(url);
  return {
    url: parsed.normalizedUrl ?? url,
    videoId: parsed.videoId,
    title: null,
    channelName: null,
    channelUrl: null,
    description: null,
    hashtags: [],
    visiblePageText: "",
    hasPlatformAiLabel: false,
    platformAiLabelText: null,
    transcript: null
  };
}

function selectedFixture(): MockShortFixture | null {
  return state.fixtures.find((fixture) => fixture.id === state.selectedFixtureId) ?? null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}
