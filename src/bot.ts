import { Bot } from "./deps.deno.ts";
import { config } from "./config/env.ts";
import { setupCommands } from "./commands/index.ts";
import { setupCronJobs } from "./jobs/cron.ts";

// Create bot instance
export const bot = new Bot(config.telegramBotToken);
console.log("Bot created");

// Setup commands
setupCommands(bot);

// Setup cron jobs
setupCronJobs(bot);

// Notify admins about bot startup
export async function notifyAdmins() {
  try {
    console.log(`Sending notification to admin ${config.adminId}...`);
    await bot.api.sendMessage(config.adminId, "Bot has been restarted ", {
      disable_notification: true,
      parse_mode: "HTML"
    }).catch(error => {
      if (error.error_code === 403) {
        console.log(`Admin ${config.adminId} has blocked the bot`);
      } else if (error.error_code === 404) {
        console.log(`Admin ${config.adminId} hasn't started the bot. Please open the bot and send /start command`);
      } else {
        console.error(`Error sending message to admin ${config.adminId}:`, error);
      }
    });
  } catch (error) {
    console.error(`Unexpected error sending message to admin ${config.adminId}:`, error);
  }
} 