import type { Bot } from "../deps.deno.ts";
import { isAdmin } from "../utils/helpers.ts";
import * as kvService from "../services/kv.ts";

export function setupCommands(bot: Bot) {
  bot.command("start", async (ctx) => {
    console.log("Received /start command from user:", ctx.from?.id);
    await ctx.reply("Pinterest-to-Telegram Bot\n\nSend /help to view available commands");
  });

  bot.command("help", async (ctx) => {
    console.log("❓ Received /help command from user:", ctx.from?.id);
    await ctx.reply(`Available commands:
/status - Show system status
/force_publish - Publish next pin
/clear - Clear storage (admin only)
/reset_published - Reset publication status (admin only)`);
  });

  bot.command("status", async (ctx) => {
    console.log("Received /status command from user:", ctx.from?.id);
    const [total, unpublished] = await Promise.all([
      kvService.countPins(),
      kvService.countUnpublishedPins(),
    ]);
    const nextCron = new Date(Date.now() + 300000);
    console.log(`Stats: Total ${total} pins, Unpublished: ${unpublished}`);
    await ctx.reply(`Statistics:
Total pins: ${total}
Unpublished: ${unpublished}
Next check: ${nextCron.toLocaleTimeString()}`);
  });

  bot.command("clear", async (ctx) => {
    console.log("Received /clear command from user:", ctx.from?.id);
    if (!ctx.from || !isAdmin(ctx.from.id)) {
      console.log("Access denied for user:", ctx.from?.id);
      return ctx.reply("Access denied. Admin only command.");
    }
    
    const deleted = await kvService.clearStorage();
    await ctx.reply(`Storage cleared. Removed ${deleted} pins`);
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