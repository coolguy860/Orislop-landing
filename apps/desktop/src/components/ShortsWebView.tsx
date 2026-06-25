import type { ExtractedShort } from "../../../../packages/shared/src/types.ts";

export type ShortsWebViewState = {
  shortsUrl: string;
  extractedShort: ExtractedShort | null;
  webviewReady: boolean;
};

export function renderShortsWebView(state: ShortsWebViewState): string {
  return `
    <section class="shorts-shell panel" aria-label="YouTube Shorts mode">
      <div class="panel__header">
        <div>
          <h2>YouTube Shorts</h2>
          <p class="muted">Focused Shorts mode only. Live auto-scroll comes later.</p>
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
