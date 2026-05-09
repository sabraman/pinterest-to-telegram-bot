import { Bot, GrammyError } from "grammy";
import { config } from "../config/env.ts";
import * as storage from "../services/storage.ts";
import { delay } from "../utils/helpers.ts";

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function assertImageAvailable(imageUrl: string): Promise<void> {
  const signal = AbortSignal.timeout(config.fetchTimeoutSeconds * 1000);
  const headers = {
    "user-agent": "pinterest-to-telegram-bot/1.0",
  };

  try {
    const head = await fetch(imageUrl, {
      method: "HEAD",
      headers,
      signal,
    });

    if (head.ok) {
      return;
    }
  } catch (error) {
    console.warn(`HEAD check failed for ${imageUrl}, falling back to ranged GET:`, error);
  }

  const response = await fetch(imageUrl, {
    headers: {
      ...headers,
      range: "bytes=0-0",
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Image returned HTTP ${response.status}`);
  }

  await response.body?.cancel();
}

export async function publishNextPin(bot: Bot): Promise<boolean> {
  const pin = storage.claimNextPin();
  if (!pin) {
    console.log("Publish queue is empty");
    return false;
  }

  console.log(`Publishing pin ${pin.guid} (attempt ${pin.attempts})`);

  try {
    await assertImageAvailable(pin.imageUrl);
    await bot.api.sendPhoto(config.telegramChannelId, pin.imageUrl);
    if (pin.lockToken && storage.markPublished(pin.guid, pin.lockToken)) {
      console.log(`Published pin ${pin.guid}`);
    } else {
      console.warn(`Published pin ${pin.guid}, but lease was already released`);
    }
    await delay(1000);
    return true;
  } catch (error) {
    const message = describeError(error);

    if (error instanceof GrammyError && (error.error_code === 400 || error.error_code === 404)) {
      console.error(`Skipping pin ${pin.guid}: ${message}`);
      if (pin.lockToken) storage.markSkipped(pin.guid, pin.lockToken, message);
      return false;
    }

    if (message.includes("HTTP 404") || message.includes("HTTP 403")) {
      console.error(`Skipping unavailable image ${pin.guid}: ${message}`);
      if (pin.lockToken) storage.markSkipped(pin.guid, pin.lockToken, message);
      return false;
    }

    console.error(`Publish failed for ${pin.guid}: ${message}`);
    if (pin.lockToken) storage.markFailed(pin.guid, pin.lockToken, message);
    return false;
  }
}
