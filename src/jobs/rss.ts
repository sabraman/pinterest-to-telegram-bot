import { XMLParser } from "fast-xml-parser";
import { config } from "../config/env.ts";
import * as storage from "../services/storage.ts";
import type { RssEntry } from "../types/index.ts";
import { extractMediaFromHtml, mediaIdentity, parseRssEntry, uniqueMediaItems } from "../utils/helpers.ts";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "#text",
});

function entriesFromFeed(xml: string): RssEntry[] {
  const feed = parser.parse(xml) as {
    rss?: { channel?: { item?: RssEntry | RssEntry[] } };
    feed?: { entry?: RssEntry | RssEntry[] };
  };

  const rssItems = feed.rss?.channel?.item;
  const atomEntries = feed.feed?.entry;
  const entries = rssItems ?? atomEntries ?? [];

  return Array.isArray(entries) ? entries : [entries];
}

function entryDate(entry: RssEntry): Date | null {
  const raw = typeof entry.published === "string" ? entry.published : entry.pubDate;
  const date = raw ? new Date(raw) : null;

  return date && !Number.isNaN(date.getTime()) ? date : null;
}

async function resolvePinPageMedia(pinUrl: string | undefined) {
  if (!pinUrl) return [];

  console.log(`Resolving Pinterest media from pin page: ${pinUrl}`);
  const response = await fetch(pinUrl, {
    signal: AbortSignal.timeout(config.fetchTimeoutSeconds * 1000),
    headers: {
      "user-agent": "pinterest-to-telegram-bot/1.0",
      accept: "text/html",
    },
  });

  if (!response.ok) {
    throw new Error(`Pinterest pin page returned HTTP ${response.status}`);
  }

  return extractMediaFromHtml(await response.text());
}

export async function fetchAndStorePins(): Promise<number> {
  console.log("Downloading Pinterest RSS feed...");
  const timeout = AbortSignal.timeout(config.fetchTimeoutSeconds * 1000);
  const response = await fetch(config.pinterestRssFeed, {
    signal: timeout,
    headers: {
      "user-agent": "pinterest-to-telegram-bot/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Pinterest RSS returned HTTP ${response.status}`);
  }

  const entries = entriesFromFeed(await response.text());
  let saved = 0;
  let skipped = 0;

  for (const entry of entries) {
    const pin = parseRssEntry(entry);
    const hasRssMedia = pin.mediaItems.length > 0;
    const existingPin = pin.guid ? storage.getPin(pin.guid) : null;
    const shouldEnrich = !existingPin
      || (
        (existingPin.status === "pending" || existingPin.status === "failed")
        && existingPin.mediaType === "photo"
      );

    if (!hasRssMedia && !entryDate(entry)) {
      skipped++;
      continue;
    }

    if (pin.guid && shouldEnrich) {
      try {
        const resolvedMedia = await resolvePinPageMedia(pin.sourceUrl);
        const rssIdentities = new Set(pin.mediaItems.map(mediaIdentity));
        const matchingResolvedMedia = resolvedMedia.filter((item) => rssIdentities.has(mediaIdentity(item)));
        const enrichedMedia = pin.mediaItems.length === 0
          ? resolvedMedia
          : uniqueMediaItems([
            ...(matchingResolvedMedia.length > 0 ? matchingResolvedMedia : []),
            ...pin.mediaItems,
          ]);
        const primaryMedia = enrichedMedia[0];
        if (primaryMedia) {
          pin.mediaItems = enrichedMedia;
          pin.mediaType = primaryMedia.type;
          pin.imageUrl = primaryMedia.url;
        }
      } catch (error) {
        console.error(`Could not resolve media for ${pin.guid}:`, error);
      }
    }

    if (!pin.guid || pin.mediaItems.length === 0) {
      skipped++;
      continue;
    }

    if (existingPin) {
      storage.updateQueuedPinMedia(pin);
      continue;
    }

    if (storage.hasMediaUrl(pin.imageUrl, pin.guid)) {
      skipped++;
      continue;
    }

    if (storage.savePin(pin)) {
      saved++;
    }
  }

  console.log(`RSS parsed: ${entries.length} entries, ${saved} new, ${skipped} without image`);
  return saved;
}
