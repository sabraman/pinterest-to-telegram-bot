import { bot, notifyAdmins } from "./bot.ts";
import { closeStorage } from "./services/storage.ts";
import { startWorkers, stopWorkers } from "./jobs/workers.ts";

let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;

  console.log(`Received ${signal}, shutting down...`);
  stopWorkers();
  await bot.stop();
  closeStorage();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

console.log("Starting long-polling bot...");
await bot.api.deleteWebhook({ drop_pending_updates: false });
await bot.start({
  drop_pending_updates: false,
  onStart: (info) => {
    console.log(`Bot @${info.username} started with long polling`);
    startWorkers(bot);
    void notifyAdmins();
  },
});
