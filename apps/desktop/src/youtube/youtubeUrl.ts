export type YouTubeShortsUrlInfo = {
  input: string;
  isYouTubeUrl: boolean;
  isShortsUrl: boolean;
  normalizedUrl: string | null;
  videoId: string | null;
};

export const YOUTUBE_SHORTS_HOME_URL = "https://www.youtube.com/shorts";

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com"
]);

export function parseYouTubeShortsUrl(input: string): YouTubeShortsUrlInfo {
  const trimmed = input.trim();
  if (!trimmed) {
    return emptyUrlInfo(input);
  }

  try {
    const parsed = new URL(trimmed.startsWith("http") ? trimmed : `https://${trimmed}`);
    const host = parsed.hostname.toLowerCase();
    const isYouTubeUrl = YOUTUBE_HOSTS.has(host);
    const videoId = isYouTubeUrl ? extractShortsVideoIdFromPath(parsed.pathname) : null;
    const isShortsUrl = isYouTubeUrl && parsed.pathname === "/shorts" || Boolean(videoId);

    return {
      input,
      isYouTubeUrl,
      isShortsUrl,
      normalizedUrl: isShortsUrl ? normalizeShortsUrl(videoId) : null,
      videoId
    };
  } catch {
    return emptyUrlInfo(input);
  }
}

export function normalizeShortsUrl(videoId: string | null): string {
  return videoId ? `${YOUTUBE_SHORTS_HOME_URL}/${encodeURIComponent(videoId)}` : YOUTUBE_SHORTS_HOME_URL;
}

export function isYouTubeShortsUrl(input: string): boolean {
  return parseYouTubeShortsUrl(input).isShortsUrl;
}

export function extractShortsVideoId(input: string): string | null {
  return parseYouTubeShortsUrl(input).videoId;
}

function extractShortsVideoIdFromPath(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "shorts") {
    return null;
  }

  return parts[1] ? decodeURIComponent(parts[1]) : null;
}

function emptyUrlInfo(input: string): YouTubeShortsUrlInfo {
  return {
    input,
    isYouTubeUrl: false,
    isShortsUrl: false,
    normalizedUrl: null,
    videoId: null
  };
}
