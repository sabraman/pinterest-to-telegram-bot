function required(name: string): string {
  const value = Bun.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = Bun.env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function requiredInteger(name: string): number {
  const raw = required(name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

export const config = {
  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  telegramChannelId: required("TELEGRAM_CHANNEL_ID").replace(/['"]/g, ""),
  adminId: requiredInteger("ADMIN_ID"),
  pinterestRssFeed: required("PINTEREST_FEED"),
  databasePath: Bun.env.DATABASE_PATH?.trim() || "data/bot.sqlite",
  rssPollSeconds: integer("RSS_POLL_SECONDS", 180),
  publishPollSeconds: integer("PUBLISH_POLL_SECONDS", 900),
  publishRetrySeconds: integer("PUBLISH_RETRY_SECONDS", 300),
  queueLockSeconds: integer("QUEUE_LOCK_SECONDS", 120),
  maxPublishAttempts: integer("MAX_PUBLISH_ATTEMPTS", 5),
  fetchTimeoutSeconds: integer("FETCH_TIMEOUT_SECONDS", 30),
  publishSendDelayMs: integer("PUBLISH_SEND_DELAY_MS", 1000),
};
