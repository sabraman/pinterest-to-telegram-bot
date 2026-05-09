import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

Bun.env.TELEGRAM_BOT_TOKEN = "test-token";
Bun.env.TELEGRAM_CHANNEL_ID = "-1001219339693";
Bun.env.ADMIN_ID = "126642711";
Bun.env.PINTEREST_FEED = "https://example.test/feed.rss";
Bun.env.DATABASE_PATH = "/tmp/pinterest-bot-storage-test.sqlite";
Bun.env.PUBLISH_RETRY_SECONDS = "1";
Bun.env.QUEUE_LOCK_SECONDS = "1";
Bun.env.MAX_PUBLISH_ATTEMPTS = "2";
Bun.env.FETCH_TIMEOUT_SECONDS = "5";

rmSync(Bun.env.DATABASE_PATH, { force: true });
rmSync(`${Bun.env.DATABASE_PATH}-shm`, { force: true });
rmSync(`${Bun.env.DATABASE_PATH}-wal`, { force: true });

const storage = await import("./storage.ts");
const { fetchAndStorePins } = await import("../jobs/rss.ts");
const { publishNextPin } = await import("../jobs/publisher.ts");
const { GrammyError } = await import("grammy");
const originalFetch = globalThis.fetch;

function pin(guid: string) {
  return {
    guid,
    imageUrl: `https://example.test/${guid}.jpg`,
    sourceUrl: `https://example.test/${guid}`,
    published: false,
    pubDate: new Date(`2026-01-0${guid.length}T00:00:00Z`).toISOString(),
  };
}

beforeEach(() => {
  storage.clearStorage();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  storage.closeStorage();
  rmSync(Bun.env.DATABASE_PATH!, { force: true });
  rmSync(`${Bun.env.DATABASE_PATH}-shm`, { force: true });
  rmSync(`${Bun.env.DATABASE_PATH}-wal`, { force: true });
});

describe("SQLite queue storage", () => {
  test("stores pins idempotently", () => {
    expect(storage.savePin(pin("a"))).toBe(true);
    expect(storage.savePin(pin("a"))).toBe(false);
    expect(storage.getStats()).toEqual({
      total: 1,
      pending: 1,
      processing: 0,
      done: 0,
      failed: 0,
      skipped: 0,
    });
  });

  test("claims pins in publication order and marks published", () => {
    storage.savePin({ ...pin("b"), pubDate: "2026-01-02T00:00:00.000Z" });
    storage.savePin({ ...pin("a"), pubDate: "2026-01-01T00:00:00.000Z" });

    const claimed = storage.claimNextPin();
    expect(claimed?.guid).toBe("a");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.lockToken).toBeString();

    expect(storage.markPublished("a", claimed!.lockToken!)).toBe(true);
    expect(storage.getStats().done).toBe(1);
    expect(storage.getStats().pending).toBe(1);
  });

  test("retries failed pins and marks exhausted failures", async () => {
    storage.savePin(pin("a"));

    const first = storage.claimNextPin();
    expect(first?.guid).toBe("a");
    expect(storage.markFailed("a", first!.lockToken!, "temporary failure")).toBe(true);
    expect(storage.getStats().failed).toBe(1);
    expect(storage.claimNextPin()).toBeNull();

    await Bun.sleep(1100);

    const second = storage.claimNextPin();
    expect(second?.guid).toBe("a");
    expect(second?.attempts).toBe(2);
    expect(storage.markFailed("a", second!.lockToken!, "terminal failure")).toBe(true);

    const stats = storage.getStats();
    expect(stats.pending).toBe(0);
    expect(stats.failed).toBe(1);
  });

  test("marks skipped pins and supports reset and clear", () => {
    storage.savePin(pin("a"));
    const claimed = storage.claimNextPin();
    expect(claimed?.guid).toBe("a");

    expect(storage.markSkipped("a", claimed!.lockToken!, "missing image")).toBe(true);
    expect(storage.getStats().skipped).toBe(1);

    expect(storage.resetPublished()).toBe(1);
    expect(storage.getStats().pending).toBe(1);

    expect(storage.clearStorage()).toBe(1);
    expect(storage.getStats().total).toBe(0);
  });

  test("stale lock tokens cannot overwrite current queue state", async () => {
    storage.savePin(pin("a"));

    const first = storage.claimNextPin();
    expect(first?.lockToken).toBeString();
    await Bun.sleep(1100);

    const second = storage.claimNextPin();
    expect(second?.guid).toBe("a");
    expect(second?.lockToken).toBeString();
    expect(second?.lockToken).not.toBe(first?.lockToken);

    expect(storage.markFailed("a", first!.lockToken!, "stale failure")).toBe(false);
    expect(storage.markPublished("a", second!.lockToken!)).toBe(true);

    const stats = storage.getStats();
    expect(stats.done).toBe(1);
    expect(stats.failed).toBe(0);
  });
});

describe("RSS ingestion", () => {
  test("parses RSS items and skips entries without images", async () => {
    globalThis.fetch = (async () => new Response(`
      <rss>
        <channel>
          <item>
            <guid>pin-1</guid>
            <link>https://ru.pinterest.com/pin/1/</link>
            <pubDate>Sat, 09 May 2026 12:00:00 GMT</pubDate>
            <description>&lt;img src=&quot;https://i.pinimg.com/236x/example.jpg&quot; /&gt;</description>
          </item>
          <item>
            <guid>pin-2</guid>
            <link>https://ru.pinterest.com/pin/2/</link>
            <description>No image here</description>
          </item>
        </channel>
      </rss>
    `, { status: 200 })) as unknown as typeof fetch;

    await expect(fetchAndStorePins()).resolves.toBe(1);
    expect(storage.getStats()).toEqual({
      total: 1,
      pending: 1,
      processing: 0,
      done: 0,
      failed: 0,
      skipped: 0,
    });
  });

  test("throws on non-OK feed responses", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;

    await expect(fetchAndStorePins()).rejects.toThrow("Pinterest RSS returned HTTP 503");
  });
});

describe("publisher", () => {
  function bot(sendPhoto: () => Promise<void>) {
    return {
      api: {
        sendPhoto,
      },
    };
  }

  test("publishes photo after falling back from failed HEAD to ranged GET", async () => {
    storage.savePin(pin("a"));
    const calls: string[] = [];

    globalThis.fetch = (async (_url: URL | RequestInfo, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push(method);
      if (method === "HEAD") {
        throw new Error("HEAD unsupported");
      }
      return new Response("", { status: 206 });
    }) as unknown as typeof fetch;

    let sent = 0;
    await expect(publishNextPin(bot(async () => {
      sent++;
    }) as never)).resolves.toBe(true);

    expect(calls).toEqual(["HEAD", "GET"]);
    expect(sent).toBe(1);
    expect(storage.getStats().done).toBe(1);
  });

  test("skips inaccessible images", async () => {
    storage.savePin(pin("a"));

    globalThis.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;

    await expect(publishNextPin(bot(async () => {
      throw new Error("sendPhoto should not be called");
    }) as never)).resolves.toBe(false);

    expect(storage.getStats().skipped).toBe(1);
  });

  test("skips Telegram 400 and retries transient send failures", async () => {
    storage.savePin(pin("a"));
    storage.savePin(pin("b"));
    globalThis.fetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;

    await expect(publishNextPin(bot(async () => {
      throw new GrammyError("Call failed", {
        ok: false,
        error_code: 400,
        description: "Bad Request: wrong file identifier",
      }, "sendPhoto", {});
    }) as never)).resolves.toBe(false);
    expect(storage.getStats().skipped).toBe(1);

    await expect(publishNextPin(bot(async () => {
      throw new Error("network down");
    }) as never)).resolves.toBe(false);
    expect(storage.getStats().failed).toBe(1);
  });
});
