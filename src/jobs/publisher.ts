import { Bot, GrammyError } from "grammy";
import { config } from "../config/env.ts";
import * as storage from "../services/storage.ts";
import { delay } from "../utils/helpers.ts";
import type { MediaItem } from "../types/index.ts";

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function assertMediaAvailable(mediaUrl: string): Promise<void> {
  const signal = AbortSignal.timeout(config.fetchTimeoutSeconds * 1000);
  const headers = {
    "user-agent": "pinterest-to-telegram-bot/1.0",
  };

  try {
    const head = await fetch(mediaUrl, {
      method: "HEAD",
      headers,
      signal,
    });

    if (head.ok) {
      return;
    }
  } catch (error) {
    console.warn(`HEAD check failed for ${mediaUrl}, falling back to ranged GET:`, error);
  }

  const response = await fetch(mediaUrl, {
    headers: {
      ...headers,
      range: "bytes=0-0",
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Media returned HTTP ${response.status}`);
  }

  await response.body?.cancel();
}

async function sendMedia(bot: Bot, mediaItems: MediaItem[]): Promise<void> {
  if (mediaItems.length === 0) {
    throw new Error("Pin has no media items");
  }

  if (
    mediaItems.length > 1
    && mediaItems.every((item) => item.type === "photo" || item.type === "video")
  ) {
    const group = mediaItems.slice(0, 10);

    if (group.length === 1) {
      await sendMedia(bot, group);
      return;
    }

    await bot.api.sendMediaGroup(config.telegramChannelId, group.map((item) => ({
      type: item.type === "video" ? "video" : "photo",
      media: item.url,
    })));
    return;
  }

  if (mediaItems.length > 1) {
    await sendMedia(bot, [mediaItems[0]!]);
    return;
  }

  const item = mediaItems[0]!;
  if (item.type === "video") {
    await bot.api.sendVideo(config.telegramChannelId, item.url);
    return;
  }

  if (item.type === "animation") {
    await bot.api.sendAnimation(config.telegramChannelId, item.url);
    return;
  }

  await bot.api.sendPhoto(config.telegramChannelId, item.url);
}

function mediaForSinglePublishAttempt(mediaItems: MediaItem[]): MediaItem[] {
  if (mediaItems.every((item) => item.type === "photo" || item.type === "video")) {
    return mediaItems.slice(0, 10);
  }

  return mediaItems[0] ? [mediaItems[0]] : [];
}

export async function publishNextPin(bot: Bot): Promise<boolean> {
  const pin = storage.claimNextPin();
  if (!pin) {
    console.log("Publish queue is empty");
    return false;
  }

  console.log(`Publishing pin ${pin.guid} (attempt ${pin.attempts})`);

  try {
    const mediaItems = mediaForSinglePublishAttempt(pin.mediaItems);
    for (const item of mediaItems) {
      await assertMediaAvailable(item.url);
    }
    await sendMedia(bot, mediaItems);
    if (pin.lockToken && storage.markPublished(pin.guid, pin.lockToken)) {
      console.log(`Published pin ${pin.guid}`);
    } else {
      console.warn(`Published pin ${pin.guid}, but lease was already released`);
    }
    await delay(config.publishSendDelayMs);
    return true;
  } catch (error) {
    const message = describeError(error);

    if (error instanceof GrammyError && (error.error_code === 400 || error.error_code === 404)) {
      console.error(`Skipping pin ${pin.guid}: ${message}`);
      if (pin.lockToken) storage.markSkipped(pin.guid, pin.lockToken, message);
      return false;
    }

    if (message.includes("HTTP 404") || message.includes("HTTP 403")) {
      console.error(`Skipping unavailable media ${pin.guid}: ${message}`);
      if (pin.lockToken) storage.markSkipped(pin.guid, pin.lockToken, message);
      return false;
    }

    console.error(`Publish failed for ${pin.guid}: ${message}`);
    if (pin.lockToken) storage.markFailed(pin.guid, pin.lockToken, message);
    return false;
  }
}
