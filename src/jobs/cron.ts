import { type Bot, GrammyError } from "../deps.deno.ts";
import { parseFeed } from "../deps.deno.ts";
import { config } from "../config/env.ts";
import { parseRssEntry, delay } from "../utils/helpers.ts";
import * as kvService from "../services/kv.ts";

export function setupCronJobs(bot: Bot) {
  // RSS Feed parsing job
  Deno.cron("Parse RSS Feed", config.cronSchedule.rssParsing, async () => {
    console.log("Starting scheduled RSS parsing...");
    try {
      const newPinsCount = await fetchAndStorePins();
      console.log("RSS parsing completed");
      
      // Only notify if new pins were found
      if (newPinsCount > 0) {
        await bot.api.sendMessage(config.adminId, `RSS parsing completed\nSaved ${newPinsCount} new pins`, {
          disable_notification: true
        }).catch(error => {
          console.error("Error sending parsing notification to admin:", error);
        });
      }
    } catch (error: unknown) {
      console.error("Error in parsing cron job:", error);
      const errorMessage = error instanceof Error 
        ? error.message 
        : "Unknown error";
      await bot.api.sendMessage(config.adminId, `RSS parsing error:\n${errorMessage}`, {
        disable_notification: true
      }).catch(console.error);
    }
  });

  // Publishing job
  Deno.cron("Publish to Channel", config.cronSchedule.publishing, async () => {
    console.log("Starting scheduled channel publishing...");
    try {
      await publishNextPin(bot);
      console.log("Scheduled publishing completed");
    } catch (error) {
      console.error("Error in publishing cron job:", error);
    }
  });
}

async function fetchAndStorePins(): Promise<number> {
  try {
    console.log("Starting RSS feed download...");
    const response = await fetch(config.pinterestRssFeed);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const feed = await parseFeed(await response.text());
    console.log(`Received ${feed.entries.length} entries from RSS`);
    let newPins = 0;

    for (const entry of feed.entries) {
      const guid = entry.id;
      const existingPin = await kvService.getPinByGuid(guid);
      if (!existingPin) {
        const pin = parseRssEntry(entry);
        console.log(`New pin: ${guid}\nURL: ${pin.imageUrl}`);
        await kvService.savePin(pin);
        newPins++;
      }
    }
    
    console.log(`Saved ${newPins} new pins`);
    return newPins;
  } catch (error) {
    console.error("Error loading RSS:", error);
    return 0;
  }
}

async function publishNextPin(bot: Bot) {
  console.log("Starting next pin publication...");
  const unpublishedPins = await kvService.getUnpublishedPins();
  
  for (const pin of unpublishedPins) {
    try {
      console.log(`\nProcessing pin ${pin.guid}:`);
      console.log(`Checking image availability: ${pin.imageUrl}`);
      
      const imageResponse = await fetch(pin.imageUrl);
      if (!imageResponse.ok) {
        console.error(`Image not accessible (HTTP ${imageResponse.status}): ${pin.imageUrl}`);
        await kvService.updatePinStatus(pin.guid, true);
        continue;
      }
      console.log("Image is accessible");

      console.log("Sending to Telegram...");
      const cleanChannelId = config.telegramChannelId.replace(/['"]/g, '');
      await bot.api.sendPhoto(cleanChannelId, pin.imageUrl);
      
      await kvService.updatePinStatus(pin.guid, true);
      console.log(`Published pin ${pin.guid}`);
      await delay(1000);
      return;
    } catch (error) {
      if (error instanceof GrammyError && (error.error_code === 404 || error.error_code === 400)) {
        console.error(`Telegram API error publishing image ${pin.imageUrl}`);
        console.error(`Error details: ${error.description}`);
        await kvService.updatePinStatus(pin.guid, true);
        continue;
      }
      console.error(`Unexpected error publishing ${pin.guid}:`, error);
      await delay(5000);
    }
  }
  
  console.log("\nPublication status:");
  if (unpublishedPins.length === 0) {
    console.log("All pins are published");
  } else {
    console.log("No pins to publish");
  }
} 