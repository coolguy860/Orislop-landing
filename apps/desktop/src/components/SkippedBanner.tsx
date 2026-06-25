import type { OrislopScoreResult } from "../../../../packages/shared/src/types.ts";

export function renderSkippedBanner(
  result: OrislopScoreResult | null,
  dismissed: boolean
): string {
  if (!result || result.action !== "skip" || dismissed) {
    return "";
  }

  return `
    <aside class="skipped-banner" role="status">
      <strong>${escapeHtml(result.userFacingReason ?? "Skipped: likely low-value content")}</strong>
      <span>Orislop flagged this because: ${escapeHtml(result.skipReason ?? "matched local rules")}</span>
    </aside>
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
