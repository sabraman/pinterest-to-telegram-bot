import { config } from "../config/env.ts";
import type { Pin, RssEntry } from "../types/index.ts";

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

export function parseRssEntry(entry: RssEntry): Pin {
  const description = typeof entry.description === "string"
    ? entry.description
    : entry.description?.value;

  const decodedDescription = description
    ?.replace(/&quot;/g, '"')
    ?.replace(/&lt;/g, '<')
    ?.replace(/&gt;/g, ">")
    ?.replace(/&amp;/g, "&") || "";

  const imgMatch = decodedDescription.match(/src=["']([^"']+)["']/);
  let imageUrl = imgMatch?.[1]?.replace(/\s+/g, "") || "";

  if (imageUrl) {
    imageUrl = imageUrl
      .replace("/236x/", "/originals/")
      .replace("236x", "1024x")
      .replace("236x", "736x");
  }

  const rawGuid = textValue(entry.id) || textValue(entry.guid);
  const link = textValue(entry.link);

  return {
    guid: rawGuid || link || imageUrl,
    imageUrl,
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
