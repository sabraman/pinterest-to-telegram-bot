import { config } from "../config/env.ts";
import type { MediaItem, MediaType, Pin, RssEntry } from "../types/index.ts";

function textValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return textValue(record["#text"] ?? record.text ?? record.href);
  }
  return undefined;
}

function dateValue(value: unknown): string {
  const raw = textValue(value);
  const date = raw ? new Date(raw) : new Date();
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function normalizePinterestImage(url: string): string {
  return url
    .replace(/\s+/g, "")
    .replace(/\/\d+x\d*\//, "/originals/");
}

export function mediaTypeFromUrl(url: string): MediaType {
  const cleanUrl = url.split("?")[0]?.toLowerCase() ?? url.toLowerCase();

  if (cleanUrl.endsWith(".gif")) return "animation";
  if (cleanUrl.endsWith(".mp4") || cleanUrl.endsWith(".mov") || cleanUrl.endsWith(".webm")) {
    return "video";
  }

  return "photo";
}

export function mediaIdentity(item: MediaItem): string {
  try {
    const parsed = new URL(item.url);
    if (parsed.hostname.endsWith("pinimg.com")) {
      const filename = parsed.pathname.split("/").pop() ?? item.url;
      return filename.replace(/\.(?:jpe?g|png|webp|gif|mp4|mov|webm)$/i, "");
    }
  } catch {
    // Fall back to URL identity below.
  }

  return item.url;
}

function mediaRank(item: MediaItem): number {
  if (item.type === "video") return 3;
  if (item.type === "animation") return 2;
  return 1;
}

export function uniqueMediaItems(items: MediaItem[]): MediaItem[] {
  const byIdentity = new Map<string, MediaItem>();

  for (const item of items) {
    if (!item.url) continue;

    const identity = mediaIdentity(item);
    const existing = byIdentity.get(identity);
    if (!existing || mediaRank(item) > mediaRank(existing)) {
      byIdentity.set(identity, item);
    }
  }

  return [...byIdentity.values()];
}

function isLikelyContentMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    if (hostname !== "i.pinimg.com" && hostname !== "v.pinimg.com") return false;
    if (
      pathname.includes("/webapp/")
      || pathname.includes("/upload/")
      || pathname.includes("/_/_/")
      || pathname.includes("_rs/")
      || pathname.includes("favicon")
      || pathname.includes("logo")
    ) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export function extractMediaFromHtml(html: string): MediaItem[] {
  const decoded = decodeHtml(html)
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/");

  const urls = [
    ...decoded.matchAll(/https?:\/\/[^"'\\<>\s]+?\.(?:jpe?g|png|webp|gif|mp4|mov|webm)(?:\?[^"'\\<>\s]*)?/gi),
  ].map((match) => match[0]);

  return uniqueMediaItems(urls.filter(isLikelyContentMediaUrl).map((url) => {
    const type = mediaTypeFromUrl(url);
    return {
      type,
      url: type === "photo" ? normalizePinterestImage(url) : url,
    };
  }));
}

export function parseRssEntry(entry: RssEntry): Pin {
  const description = typeof entry.description === "string"
    ? entry.description
    : entry.description?.value;

  const decodedDescription = decodeHtml(description || "");

  const mediaItems = uniqueMediaItems([
    ...extractMediaFromHtml(decodedDescription),
    ...[...decodedDescription.matchAll(/src=["']([^"']+)["']/g)]
      .map((match) => match[1]?.replace(/\s+/g, "") || "")
      .filter(Boolean)
      .map((url) => {
        const type = mediaTypeFromUrl(url);
        return {
          type,
          url: type === "photo" ? normalizePinterestImage(url) : url,
        };
      }),
  ]);

  const primaryMedia = mediaItems[0];

  const rawGuid = textValue(entry.id) || textValue(entry.guid);
  const link = textValue(entry.link);

  return {
    guid: rawGuid || link || primaryMedia?.url || "",
    imageUrl: primaryMedia?.url || "",
    mediaType: primaryMedia?.type || "photo",
    mediaItems,
    sourceUrl: link,
    published: false,
    pubDate: dateValue(entry.published || entry.pubDate),
  };
}

export function isAdmin(userId: number): boolean {
  console.log("Checking admin rights:", { userId, adminId: config.adminId });
  return userId === config.adminId;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
