import type { OrislopSettings } from "../../../../packages/shared/src/types.ts";

export function renderSettingsPanel(settings: OrislopSettings | null): string {
  if (!settings) {
    return `
      <section class="panel">
        <h2>Settings</h2>
        <p class="muted">Loading settings.</p>
      </section>
    `;
  }

  return `
    <section class="panel settings-panel">
      <div class="panel__header">
        <h2>Settings</h2>
        <button type="button" data-action="reset-settings">Reset</button>
      </div>
      ${toggle("autoSkip", "Auto skip", settings.autoSkip)}
      ${toggle("skipAllAiLabeled", "Skip AI-labeled", settings.skipAllAiLabeled)}
      ${toggle("skipEngagementBait", "Skip engagement bait", settings.skipEngagementBait)}
      ${toggle("skipTemplateBrainrot", "Skip template formats", settings.skipTemplateBrainrot)}
      ${toggle("skipScamFinance", "Skip scam finance", settings.skipScamFinance)}
      ${toggle("skipHighRiskUnsupportedClaims", "Skip high-risk claims", settings.skipHighRiskUnsupportedClaims)}
      <label class="field-row">
        <span>Strictness</span>
        <select data-setting="strictness">
          ${option("lenient", settings.strictness)}
          ${option("medium", settings.strictness)}
          ${option("strict", settings.strictness)}
        </select>
      </label>
    </section>
  `;
}

function toggle(key: keyof OrislopSettings, label: string, value: boolean): string {
  return `
    <label class="field-row">
      <span>${label}</span>
      <input type="checkbox" data-setting="${key}" ${value ? "checked" : ""} />
    </label>
  `;
}

function option(value: OrislopSettings["strictness"], current: OrislopSettings["strictness"]): string {
  return `<option value="${value}" ${value === current ? "selected" : ""}>${value}</option>`;
}
