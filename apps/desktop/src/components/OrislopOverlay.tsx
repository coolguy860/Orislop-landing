import type { OrislopScoreResult } from "../../../../packages/shared/src/types.ts";

export function renderOrislopOverlay(result: OrislopScoreResult | null, cacheHit: boolean): string {
  if (!result) {
    return `
      <section class="panel overlay-panel">
        <h2>Score result</h2>
        <p class="muted">Select a fixture and run scoring.</p>
      </section>
    `;
  }

  const reasons = result.evidence.slice(0, 3);

  return `
    <section class="panel overlay-panel">
      <div class="panel__header">
        <h2>Score result</h2>
        <span class="status-pill status-pill--${result.action}">${result.action}</span>
      </div>
      <p class="reason-copy">${escapeHtml(result.userFacingReason ?? "Orislop flagged this because: review the reasons below.")}</p>
      <dl class="score-grid">
        <div><dt>Skip probability</dt><dd>${formatScore(result.skipProbability)}</dd></div>
        <div><dt>Slop</dt><dd>${formatScore(result.slopScore)}</dd></div>
        <div><dt>Claim risk</dt><dd>${formatScore(result.claimRiskScore)}</dd></div>
        <div><dt>Cache</dt><dd>${cacheHit ? "Hit" : "Fresh"}</dd></div>
      </dl>
      <h3>Top reasons</h3>
      <ol class="reason-list">
        ${reasons.map((reason) => `
          <li>
            <strong>${escapeHtml(reason.label)}</strong>
            <span>${escapeHtml(reason.detail)}</span>
          </li>
        `).join("") || "<li><span>No specific rule evidence.</span></li>"}
      </ol>
      <p class="caution">This may be wrong.</p>
    </section>
  `;
}

function formatScore(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}
