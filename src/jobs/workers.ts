import type { Bot } from "grammy";
import { config } from "../config/env.ts";
import { fetchAndStorePins } from "./rss.ts";
import { publishNextPin } from "./publisher.ts";

type WorkerTask = () => Promise<void>;

const timers: ReturnType<typeof setInterval>[] = [];
const failureNotifiedAt = new Map<string, number>();

async function notifyFailure(bot: Bot, name: string, error: unknown): Promise<void> {
  const now = Date.now();
  const lastNotifiedAt = failureNotifiedAt.get(name) ?? 0;
  const minIntervalMs = 30 * 60 * 1000;

  if (now - lastNotifiedAt < minIntervalMs) {
    return;
  }

  failureNotifiedAt.set(name, now);
  const message = error instanceof Error ? error.message : String(error);
  await bot.api.sendMessage(config.adminId, `${name} failed:\n${message.slice(0, 1500)}`, {
    disable_notification: true,
  }).catch(console.error);
}

function startLoop(
  bot: Bot,
  name: string,
  intervalSeconds: number,
  task: WorkerTask,
  runImmediately = true,
): void {
  let running = false;

  const run = async () => {
    if (running) {
      console.log(`${name} still running, skipping this tick`);
      return;
    }

    running = true;
    try {
      await task();
    } catch (error) {
      console.error(`${name} failed:`, error);
      await notifyFailure(bot, name, error);
    } finally {
      running = false;
    }
  };

  if (runImmediately) {
    void run();
  }
  timers.push(setInterval(run, intervalSeconds * 1000));
}

export function startWorkers(bot: Bot): void {
  startLoop(bot, "RSS worker", config.rssPollSeconds, async () => {
    const saved = await fetchAndStorePins();
    if (saved > 0) {
      await bot.api.sendMessage(config.adminId, `RSS parsed. Saved ${saved} new pins.`, {
        disable_notification: true,
      }).catch(console.error);
    }
  });

  startLoop(bot, "Publish worker", config.publishPollSeconds, async () => {
    await publishNextPin(bot);
  }, false);
}

export function stopWorkers(): void {
  for (const timer of timers) {
    clearInterval(timer);
  }
}
