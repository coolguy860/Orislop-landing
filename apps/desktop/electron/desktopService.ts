import { scoreVideo } from "../../../packages/slop-engine/src/scoreVideo.ts";
import type { ScoreVideoOptions, UserPreferenceRules } from "../../../packages/slop-engine/src/types.ts";
import type {
  ExtractedShort,
  OrislopScoreResult,
  OrislopSettings
} from "../../../packages/shared/src/types.ts";
import {
  CacheStore,
  ChannelPreferenceStore,
  LocalFeedbackStore,
  SkipHistoryStore,
  UserSettingsStore
} from "../../../packages/storage/src/index.ts";
import type {
  FeedbackRecord,
  SkipHistoryRecord,
  UserFeedbackAction
} from "../../../packages/storage/src/types.ts";
import { MOCK_SHORT_FIXTURES, type MockShortFixture } from "../src/mockFixtures.ts";
import type { FeedbackPayload, ScoreRequestPayload } from "./ipcValidation.ts";

export type DesktopMockServiceOptions = {
  storagePath: string;
};

export type ScoreShortResponse = {
  result: OrislopScoreResult;
  cacheHit: boolean;
};

export type FeedbackResponse = {
  record: FeedbackRecord;
  preferencesChanged: boolean;
};

export type DesktopMockService = ReturnType<typeof createDesktopMockService>;

export function createDesktopMockService(options: DesktopMockServiceOptions) {
  const settingsStore = new UserSettingsStore({ basePath: options.storagePath });
  const feedbackStore = new LocalFeedbackStore({ basePath: options.storagePath });
  const cacheStore = new CacheStore({ basePath: options.storagePath });
  const skipHistoryStore = new SkipHistoryStore({ basePath: options.storagePath });
  const channelPreferenceStore = new ChannelPreferenceStore({ basePath: options.storagePath });

  return {
    listFixtures(): MockShortFixture[] {
      return MOCK_SHORT_FIXTURES;
    },

    async getSettings(): Promise<OrislopSettings> {
      return settingsStore.load();
    },

    async updateSettings(settingsPatch: Partial<OrislopSettings>): Promise<OrislopSettings> {
      const settings = await settingsStore.save(settingsPatch);
      await cacheStore.clear();
      return settings;
    },

    async resetSettings(): Promise<OrislopSettings> {
      const settings = await settingsStore.resetToDefaults();
      await cacheStore.clear();
      return settings;
    },

    async scoreShort(payload: ScoreRequestPayload): Promise<ScoreShortResponse> {
      return scoreShortWithStores(
        payload,
        settingsStore,
        cacheStore,
        feedbackStore,
        skipHistoryStore,
        channelPreferenceStore
      );
    },

    async getCachedScore(payload: ScoreRequestPayload): Promise<OrislopScoreResult | null> {
      const settings = await settingsStore.load();
      return cacheStore.getScore(resolveShort(payload), settings);
    },

    async clearCache(): Promise<{ cleared: true }> {
      await cacheStore.clear();
      return { cleared: true };
    },

    async forceRescan(payload: ScoreRequestPayload): Promise<ScoreShortResponse> {
      return this.scoreShort({
        ...payload,
        forceRescan: true
      });
    },

    async saveFeedback(payload: FeedbackPayload): Promise<FeedbackResponse> {
      const short = payload.short ?? resolveShort(payload);
      const preferencesChanged = await applyFeedbackPreference(
        payload.userFeedback,
        payload.scoreResult,
        short,
        channelPreferenceStore
      );
      const record = await feedbackStore.append({
        videoId: short.videoId,
        url: short.url,
        title: short.title,
        channelName: short.channelName,
        channelUrl: short.channelUrl,
        scoreResult: payload.scoreResult,
        actionTaken: payload.scoreResult.action,
        userFeedback: payload.userFeedback
      });

      if (preferencesChanged) {
        await cacheStore.clear();
      }

      return {
        record,
        preferencesChanged
      };
    },

    async getSkipHistory(): Promise<SkipHistoryRecord[]> {
      return skipHistoryStore.list();
    }
  };
}

async function scoreShortWithStores(
  payload: ScoreRequestPayload,
  settingsStore: UserSettingsStore,
  cacheStore: CacheStore,
  feedbackStore: LocalFeedbackStore,
  skipHistoryStore: SkipHistoryStore,
  channelPreferenceStore: ChannelPreferenceStore
): Promise<ScoreShortResponse> {
  const short = resolveShort(payload);
  const persistedSettings = await settingsStore.load();
  const settings = payload.forceRescan
    ? { ...persistedSettings, forceRescan: true }
    : persistedSettings;
  const cached = await cacheStore.getScore(short, settings);

  if (cached) {
    return {
      result: cached,
      cacheHit: true
    };
  }

  const scoreOptions: ScoreVideoOptions = {
    userPreferences: await buildUserPreferenceRules(feedbackStore, channelPreferenceStore)
  };
  const result = scoreVideo(short, settings, scoreOptions);
  await cacheStore.saveScore(result, persistedSettings);

  if (result.action === "skip" || result.action === "pre_skip") {
    await skipHistoryStore.recordSkip({
      videoId: short.videoId,
      url: short.url,
      reason: result.skipReason,
      action: result.action
    });
  }

  return {
    result,
    cacheHit: false
  };
}

async function buildUserPreferenceRules(
  feedbackStore: LocalFeedbackStore,
  channelPreferenceStore: ChannelPreferenceStore
): Promise<UserPreferenceRules> {
  const channelRules = await channelPreferenceStore.toUserPreferenceRules();
  const alwaysBlockCategories = (await feedbackStore.list())
    .filter((record) => record.userFeedback === "always_block_format")
    .map((record) => record.scoreResult.categories[0])
    .filter((category): category is string => Boolean(category));

  return {
    alwaysAllowChannels: channelRules.alwaysAllowChannels ?? [],
    alwaysBlockChannels: channelRules.alwaysBlockChannels ?? [],
    alwaysBlockCategories: Array.from(new Set(alwaysBlockCategories))
  };
}

async function applyFeedbackPreference(
  userFeedback: UserFeedbackAction,
  scoreResult: OrislopScoreResult,
  short: ExtractedShort,
  channelPreferenceStore: ChannelPreferenceStore
): Promise<boolean> {
  if (userFeedback === "always_allow_channel") {
    await channelPreferenceStore.alwaysAllowChannel(short);
    return true;
  }

  if (userFeedback === "always_block_channel") {
    await channelPreferenceStore.alwaysBlockChannel(short);
    return true;
  }

  return userFeedback === "always_block_format" && scoreResult.categories.length > 0;
}

function resolveShort(payload: ScoreRequestPayload | FeedbackPayload): ExtractedShort {
  if (payload.short) {
    return payload.short;
  }

  const fixtureId = payload.fixtureId;
  const fixture = MOCK_SHORT_FIXTURES.find((item) => item.id === fixtureId);
  if (!fixture) {
    throw new Error(`Unknown mock fixture: ${fixtureId ?? "none"}.`);
  }

  return fixture.short;
}
