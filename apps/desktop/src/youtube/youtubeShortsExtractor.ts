import type { ExtractedShort } from "../../../../packages/shared/src/types.ts";
import { extractShortsVideoId } from "./youtubeUrl.ts";

export type YouTubeShortsExtractionSnapshot = {
  url: string;
  titleCandidates?: Array<string | null | undefined>;
  channelCandidates?: Array<{
    name: string | null;
    url: string | null;
  }>;
  descriptionCandidates?: Array<string | null | undefined>;
  visibleText?: string | null;
  transcriptCandidates?: Array<string | null | undefined>;
};

export function extractShortFromSnapshot(snapshot: YouTubeShortsExtractionSnapshot): ExtractedShort {
  const title = firstText(snapshot.titleCandidates ?? []);
  const description = firstText(snapshot.descriptionCandidates ?? []);
  const visiblePageText = normalizeWhitespace(snapshot.visibleText ?? "");
  const channel = firstChannel(snapshot.channelCandidates ?? []);
  const transcript = firstText(snapshot.transcriptCandidates ?? []);
  const disclosureText = findAiDisclosure([title, description, visiblePageText].filter(Boolean).join(" "));

  return {
    url: snapshot.url,
    videoId: extractShortsVideoId(snapshot.url),
    title,
    channelName: channel.name,
    channelUrl: channel.url,
    description,
    hashtags: extractHashtags([title, description, visiblePageText].filter(Boolean).join(" ")),
    visiblePageText,
    hasPlatformAiLabel: disclosureText !== null,
    platformAiLabelText: disclosureText,
    transcript
  };
}

export function getYouTubeShortsExtractorScript(): string {
  return `(${browserExtractCurrentShort.toString()})();`;
}

export function extractHashtags(text: string): string[] {
  const matches = text.match(/#[\p{L}\p{N}_-]+/gu) ?? [];
  return Array.from(new Set(matches.map((tag) => tag.slice(1).toLowerCase())));
}

export function findAiDisclosure(text: string): string | null {
  const match = text.match(/(?:altered|synthetic|ai-generated|ai generated|made with ai|created with ai|generated with ai|contains ai)/i);
  return match ? match[0] : null;
}

function firstText(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const normalized = normalizeWhitespace(value ?? "");
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function firstChannel(channels: NonNullable<YouTubeShortsExtractionSnapshot["channelCandidates"]>[number][]): {
  name: string | null;
  url: string | null;
} {
  for (const channel of channels) {
    const name = normalizeWhitespace(channel.name ?? "");
    const url = normalizeWhitespace(channel.url ?? "");
    if (name || url) {
      return {
        name: name || null,
        url: url || null
      };
    }
  }

  return {
    name: null,
    url: null
  };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function browserExtractCurrentShort(): ExtractedShort {
  try {
    const url = window.location.href;
    const titleCandidates = [
      textFromSelector("h1"),
      textFromSelector("h1 yt-formatted-string"),
      textFromSelector("#title"),
      textFromSelector("[id='title']"),
      document.querySelector("meta[name='title']")?.getAttribute("content"),
      document.title?.replace(/ - YouTube$/i, "")
    ];
    const descriptionCandidates = [
      textFromSelector("#description"),
      textFromSelector("ytd-expander"),
      textFromSelector("yt-formatted-string.content"),
      document.querySelector("meta[name='description']")?.getAttribute("content")
    ];
    const channelElement = document.querySelector<HTMLAnchorElement>(
      "ytd-channel-name a[href], #channel-name a[href], a[href^='/@'], a[href*='youtube.com/@']"
    );
    const visibleText = visibleTextWithoutComments();
    const snapshot = {
      url,
      titleCandidates,
      descriptionCandidates,
      channelCandidates: [{
        name: channelElement?.textContent ?? null,
        url: channelElement?.href ?? null
      }],
      visibleText,
      transcriptCandidates: []
    };

    return extractFromPlainSnapshot(snapshot);
  } catch {
    return {
      url: window.location.href,
      videoId: plainVideoIdFromUrl(window.location.href),
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

  function textFromSelector(selector: string): string | null {
    return document.querySelector(selector)?.textContent ?? null;
  }

  function visibleTextWithoutComments(): string {
    const root = document.querySelector(
      "ytd-reel-video-renderer[is-active], ytd-reel-video-renderer[is-active='true'], ytd-shorts, #shorts-container"
    ) ?? document.body;
    const clone = root?.cloneNode(true) as HTMLElement | null;
    if (!clone) {
      return "";
    }

    clone.querySelectorAll("ytd-comments, #comments, [id*='comment'], [class*='comment']").forEach((node) => node.remove());
    return normalizePlain(clone.innerText || clone.textContent || "").slice(0, 12000);
  }

  function extractFromPlainSnapshot(snapshot: {
    url: string;
    titleCandidates: Array<string | null | undefined>;
    channelCandidates: Array<{ name: string | null | undefined; url: string | null | undefined }>;
    descriptionCandidates: Array<string | null | undefined>;
    visibleText: string | null;
    transcriptCandidates: Array<string | null | undefined>;
  }): ExtractedShort {
    const title = firstPlainText(snapshot.titleCandidates);
    const description = firstPlainText(snapshot.descriptionCandidates);
    const visiblePageText = normalizePlain(snapshot.visibleText ?? "");
    const channel = firstPlainChannel(snapshot.channelCandidates);
    const joined = [title, description, visiblePageText].filter(Boolean).join(" ");
    const disclosure = plainAiDisclosure(joined);

    return {
      url: snapshot.url,
      videoId: plainVideoIdFromUrl(snapshot.url),
      title,
      channelName: channel.name,
      channelUrl: channel.url,
      description,
      hashtags: plainHashtags(joined),
      visiblePageText,
      hasPlatformAiLabel: disclosure !== null,
      platformAiLabelText: disclosure,
      transcript: firstPlainText(snapshot.transcriptCandidates)
    };
  }

  function firstPlainText(values: Array<string | null | undefined>): string | null {
    for (const value of values) {
      const normalized = normalizePlain(value ?? "");
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  function firstPlainChannel(channels: Array<{ name: string | null | undefined; url: string | null | undefined }>): {
    name: string | null;
    url: string | null;
  } {
    for (const channel of channels) {
      const name = normalizePlain(channel.name ?? "");
      const channelUrl = normalizePlain(channel.url ?? "");
      if (name || channelUrl) {
        return {
          name: name || null,
          url: channelUrl || null
        };
      }
    }

    return {
      name: null,
      url: null
    };
  }

  function plainVideoIdFromUrl(value: string): string | null {
    try {
      const urlValue = new URL(value);
      const parts = urlValue.pathname.split("/").filter(Boolean);
      return parts[0] === "shorts" && parts[1] ? decodeURIComponent(parts[1]) : null;
    } catch {
      return null;
    }
  }

  function plainHashtags(value: string): string[] {
    const matches = value.match(/#[\p{L}\p{N}_-]+/gu) ?? [];
    return Array.from(new Set(matches.map((tag) => tag.slice(1).toLowerCase())));
  }

  function plainAiDisclosure(value: string): string | null {
    const match = value.match(/(?:altered|synthetic|ai-generated|ai generated|made with ai|created with ai|generated with ai|contains ai)/i);
    return match ? match[0] : null;
  }

  function normalizePlain(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }
}
