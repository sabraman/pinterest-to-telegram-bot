import { XMLParser } from "fast-xml-parser";
import { config } from "../config/env.ts";
import * as storage from "../services/storage.ts";
import type { RssEntry } from "../types/index.ts";
import { parseRssEntry } from "../utils/helpers.ts";

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
    if (!pin.guid || !pin.imageUrl) {
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
