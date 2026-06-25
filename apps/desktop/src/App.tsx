import type {
  OrislopScoreResult,
  OrislopSettings
} from "../../../packages/shared/src/types.ts";
import type { UserFeedbackAction } from "../../../packages/storage/src/types.ts";
import { renderFeedbackPanel } from "./components/FeedbackPanel.tsx";
import { renderMockShortPanel } from "./components/MockShortPanel.tsx";
import { renderOrislopOverlay } from "./components/OrislopOverlay.tsx";
import { renderSettingsPanel } from "./components/SettingsPanel.tsx";
import { renderSkippedBanner } from "./components/SkippedBanner.tsx";
import type { MockShortFixture } from "./mockFixtures.ts";

type ScoreShortResponse = {
  result: OrislopScoreResult;
  cacheHit: boolean;
};

type OrislopApi = {
  listFixtures: () => Promise<MockShortFixture[]>;
  scoreShort: (payload: { fixtureId: string }) => Promise<ScoreShortResponse>;
  getSettings: () => Promise<OrislopSettings>;
  updateSettings: (payload: Partial<OrislopSettings>) => Promise<OrislopSettings>;
  resetSettings: () => Promise<OrislopSettings>;
  saveFeedback: (payload: {
    fixtureId: string;
    scoreResult: OrislopScoreResult;
    userFeedback: UserFeedbackAction;
  }) => Promise<unknown>;
  getCachedScore: (payload: { fixtureId: string }) => Promise<OrislopScoreResult | null>;
  clearCache: () => Promise<unknown>;
  forceRescan: (payload: { fixtureId: string }) => Promise<ScoreShortResponse>;
  getSkipHistory: () => Promise<unknown[]>;
};

declare global {
  interface Window {
    orislop: OrislopApi;
  }
}

type AppState = {
  fixtures: MockShortFixture[];
  selectedFixtureId: string | null;
  settings: OrislopSettings | null;
  scoreResponse: ScoreShortResponse | null;
  bannerDismissed: boolean;
  status: string;
  skipHistoryCount: number;
};

const state: AppState = {
  fixtures: [],
  selectedFixtureId: null,
  settings: null,
  scoreResponse: null,
  bannerDismissed: false,
  status: "Loading mock fixtures.",
  skipHistoryCount: 0
};

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
          <p>Mock fixture mode</p>
        </div>
        <span class="app-status">${escapeHtml(state.status)}</span>
      </header>

      ${renderSkippedBanner(result, state.bannerDismissed)}

      <section class="toolbar" aria-label="Fixture controls">
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
        <button type="button" data-action="clear-cache">Clear cache</button>
        <span class="history-count">Skip history: ${state.skipHistoryCount}</span>
      </section>

      <div class="content-grid">
        ${fixture ? renderMockShortPanel(fixture) : "<section class=\"panel\">No fixtures found.</section>"}
        ${renderOrislopOverlay(result, Boolean(state.scoreResponse?.cacheHit))}
        ${renderSettingsPanel(state.settings)}
        ${renderFeedbackPanel(result)}
      </div>
    </div>
  `;

  bindEvents();
}

function bindEvents(): void {
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
}

async function scoreSelected(forceRescan: boolean): Promise<void> {
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
  if (!state.selectedFixtureId || !state.scoreResponse) {
    return;
  }

  await window.orislop.saveFeedback({
    fixtureId: state.selectedFixtureId,
    scoreResult: state.scoreResponse.result,
    userFeedback
  });

  if (userFeedback === "watch_anyway" || userFeedback === "show_anyway") {
    state.bannerDismissed = true;
  }

  state.status = "Feedback saved locally.";
  render();
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
