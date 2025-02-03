import { config } from "../config/env.ts";
import type { Pin, RssEntry } from "../types/index.ts";

export function parseRssEntry(entry: RssEntry): Pin {
  const decodedDescription = entry.description?.value
    ?.replace(/&quot;/g, '"')
    ?.replace(/&lt;/g, '<')
    ?.replace(/&gt;/g, '>') || "";

  const imgMatch = decodedDescription.match(/src="([^"]+)"/);
  let imageUrl = imgMatch?.[1]?.replace(/\s+/g, "") || "";

  if (imageUrl) {
    imageUrl = imageUrl
      .replace("/236x/", "/originals/")
      .replace("236x", "1024x")
      .replace("236x", "736x");
  }

  return {
    guid: entry.id,
    imageUrl,
    published: false,
    pubDate: entry.published ? new Date(entry.published) : new Date(),
  };
}

export function isAdmin(userId: number): boolean {
  console.log("Checking admin rights:", { userId, adminId: config.adminId });
  return userId === config.adminId;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
} 