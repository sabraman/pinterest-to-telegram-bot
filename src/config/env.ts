export const config = {
  telegramBotToken: Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "",
  telegramChannelId: Deno.env.get("TELEGRAM_CHANNEL_ID") ?? "",
  adminId: Number(Deno.env.get("ADMIN_ID")) || 0,
  pinterestRssFeed: Deno.env.get("PINTEREST_FEED") ?? "",
  cronSchedule: {
    rssParsing: "*/3 * * * *", // every 3 minutes
    publishing: "*/15 * * * *" // every 15 minutes
  }
};

// Validate required environment variables
if (!config.telegramBotToken) {
  throw new Error("TELEGRAM_BOT_TOKEN is not set");
}

if (!config.telegramChannelId) {
  throw new Error("TELEGRAM_CHANNEL_ID is not set");
}

if (!config.adminId) {
  throw new Error("ADMIN_ID is not set");
} 
if (!config.pinterestRssFeed) {
  throw new Error("PINTEREST_FEED is not set");
}