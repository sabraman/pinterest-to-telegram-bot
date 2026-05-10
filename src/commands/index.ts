import type { Bot } from "grammy";
import { isAdmin } from "../utils/helpers.ts";
import * as storage from "../services/storage.ts";
import { publishNextPin } from "../jobs/publisher.ts";
import { config } from "../config/env.ts";
import { formatQueueFinishEta } from "../utils/status.ts";

export function setupCommands(bot: Bot) {
  bot.command("start", async (ctx) => {
    console.log("Received /start command from user:", ctx.from?.id);
    await ctx.reply("Pinterest-to-Telegram Bot\n\nSend /help to view available commands");
  });

  bot.command("help", async (ctx) => {
    console.log("Received /help command from user:", ctx.from?.id);
    await ctx.reply(`Available commands:
/status - Show system status
/force_publish - Publish next pin (admin only)
/clear - Clear storage (admin only)
/reset_published - Reset publication status (admin only)`);
  });

  bot.command("status", async (ctx) => {
    console.log("Received /status command from user:", ctx.from?.id);
    const stats = storage.getStats();
    const queueFinishEta = formatQueueFinishEta(stats.pending, config.publishPollSeconds);
    await ctx.reply(`Statistics:
Total pins: ${stats.total}
Pending: ${stats.pending}
Processing: ${stats.processing}
Published: ${stats.done}
Failed: ${stats.failed}
Skipped: ${stats.skipped}
Last pending pin ETA: ${queueFinishEta}`);
  });

  bot.command("force_publish", async (ctx) => {
    console.log("Received /force_publish command from user:", ctx.from?.id);
    if (!ctx.from || !isAdmin(ctx.from.id)) {
      console.log("Access denied for user:", ctx.from?.id);
      return ctx.reply("Access denied. Admin only command.");
    }

    const published = await publishNextPin(bot);
    await ctx.reply(published ? "Published next pin." : "No publishable pin found.");
  });

  bot.command("clear", async (ctx) => {
    console.log("Received /clear command from user:", ctx.from?.id);
    if (!ctx.from || !isAdmin(ctx.from.id)) {
      console.log("Access denied for user:", ctx.from?.id);
      return ctx.reply("Access denied. Admin only command.");
    }
    
    const deleted = storage.clearStorage();
    await ctx.reply(`Storage cleared. Removed ${deleted} pins`);
  });

  bot.command("reset_published", async (ctx) => {
    console.log("Received /reset_published command from user:", ctx.from?.id);
    if (!ctx.from || !isAdmin(ctx.from.id)) {
      console.log("Access denied for user:", ctx.from?.id);
      return ctx.reply("Access denied. Admin only command.");
    }

    const reset = storage.resetPublished();
    await ctx.reply(`Reset ${reset} pins to pending.`);
  });

  // Add catch-all handler for unhandled messages
  bot.on("message", async (ctx) => {
    console.log("Received message from user:", ctx.from?.id, "Text:", ctx.message?.text);
    await ctx.reply("Use /help to view available commands");
  });

  // Error handler
  bot.catch((err) => {
    console.error("Error in bot handler:", err);
  });
}
