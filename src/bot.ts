import { Bot, GrammyError } from "grammy";
import { config } from "./config/env.ts";
import { setupCommands } from "./commands/index.ts";

export const bot = new Bot(config.telegramBotToken, {
  client: {
    timeoutSeconds: config.fetchTimeoutSeconds,
  },
});
console.log("Bot created");

setupCommands(bot);

// Notify admins about bot startup
export async function notifyAdmins() {
  try {
    console.log(`Sending notification to admin ${config.adminId}...`);
    await bot.api.sendMessage(config.adminId, "Bot has been restarted", {
      disable_notification: true,
      parse_mode: "HTML"
    }).catch(error => {
      if (error instanceof GrammyError && error.error_code === 403) {
        console.log(`Admin ${config.adminId} has blocked the bot`);
      } else if (error instanceof GrammyError && (error.error_code === 400 || error.error_code === 404)) {
        console.log(`Admin ${config.adminId} hasn't started the bot. Please open the bot and send /start command`);
      } else {
        console.error(`Error sending message to admin ${config.adminId}:`, error);
      }
    });
  } catch (error) {
    console.error(`Unexpected error sending message to admin ${config.adminId}:`, error);
  }
}
