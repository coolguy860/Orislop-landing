import type { ExtractedShort } from "../../../../packages/shared/src/types.ts";
import type { ScoredLookaheadCandidate } from "../youtube/lookaheadTypes.ts";

export type ShortsWebViewState = {
  shortsUrl: string;
  extractedShort: ExtractedShort | null;
  webviewReady: boolean;
  lookaheadResults: ScoredLookaheadCandidate[];
};

export function renderShortsWebView(state: ShortsWebViewState): string {
  return `
    <section class="shorts-shell panel" aria-label="YouTube Shorts mode">
      <div class="panel__header">
        <div>
          <h2>YouTube Shorts</h2>
          <p class="muted">Focused Shorts mode only. Auto-scroll follows your local settings.</p>
        </div>
        <button type="button" data-action="analyze-current-short">Analyze current Short</button>
      </div>
      <div class="shorts-controls">
        <input
          id="shorts-url-input"
          type="url"
          value="${escapeHtml(state.shortsUrl)}"
          placeholder="https://www.youtube.com/shorts/..."
          aria-label="YouTube Shorts URL"
        />
        <button type="button" data-action="open-shorts-url">Open YouTube Shorts</button>
      </div>
      <webview
        id="shorts-webview"
        class="shorts-webview"
        src="${escapeHtml(state.shortsUrl)}"
        partition="persist:orislop-youtube-shorts"
        allowpopups="false"
      ></webview>
      <details class="extract-debug" ${state.extractedShort ? "open" : ""}>
        <summary>Extracted Short debug</summary>
        <pre>${escapeHtml(JSON.stringify(state.extractedShort, null, 2))}</pre>
      </details>
      <details class="extract-debug" ${state.lookaheadResults.length > 0 ? "open" : ""}>
        <summary>Lookahead candidates (${state.lookaheadResults.length})</summary>
        <ol class="lookahead-list">
          ${state.lookaheadResults.map((item) => `
            <li>
              <strong>${escapeHtml(item.candidate.title ?? item.candidate.videoId ?? item.candidate.extractionId)}</strong>
              <span>${escapeHtml(item.candidate.position)} - ${item.preSkip ? "pre_skip" : item.scoreResult.action} - ${item.cacheHit ? "cache" : "fresh"}</span>
            </li>
          `).join("") || "<li>No lookahead candidates scored.</li>"}
        </ol>
      </details>
    </section>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}
