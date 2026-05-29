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
Bun.env.PUBLISH_SEND_DELAY_MS = "1";

rmSync(Bun.env.DATABASE_PATH, { force: true });
rmSync(`${Bun.env.DATABASE_PATH}-shm`, { force: true });
rmSync(`${Bun.env.DATABASE_PATH}-wal`, { force: true });

const storage = await import("./storage.ts");
const { fetchAndStorePins } = await import("../jobs/rss.ts");
const { publishNextPin } = await import("../jobs/publisher.ts");
const { GrammyError } = await import("grammy");
const { extractMediaFromHtml, isContentMediaUrl, parseRssEntry } = await import("../utils/helpers.ts");
const { formatQueueFinishEta, formatRssParsedMessage } = await import("../utils/status.ts");
const originalFetch = globalThis.fetch;

function pin(guid: string) {
  const imageUrl = `https://i.pinimg.com/originals/${guid}.jpg`;
  return {
    guid,
    imageUrl,
    mediaType: "photo" as const,
    mediaItems: [{ type: "photo" as const, url: imageUrl }],
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

describe("status formatting", () => {
  test("shows absolute and relative queue finish ETA", () => {
    expect(formatQueueFinishEta(3, 900, new Date("2026-05-10T00:00:00Z"))).toBe(
      "2026-05-10, 03:45 MSK (45m from now)",
    );
  });

  test("shows no pending pins when queue is empty", () => {
    expect(formatQueueFinishEta(0, 900, new Date("2026-05-10T00:00:00Z"))).toBe("No pending pins");
  });

  test("formats RSS notification with queue finish ETA", () => {
    expect(formatRssParsedMessage(7, 10, 900)).toContain(
      "RSS parsed. Saved 7 new pins.\nLast pending pin ETA:",
    );
  });
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
    globalThis.fetch = (async (url: URL | RequestInfo) => {
      if (String(url).includes("feed.rss")) {
        return new Response(`
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
        `, { status: 200 });
      }

      return new Response("<html>No media here</html>", { status: 200 });
    }) as unknown as typeof fetch;

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

  test("parses direct video and animation media from RSS descriptions", () => {
    const video = parseRssEntry({
      guid: "video-pin",
      description: '<video src="https://v.pinimg.com/videos/example.mp4"></video>',
    });
    expect(video.mediaType).toBe("video");
    expect(video.mediaItems).toEqual([
      { type: "video", url: "https://v.pinimg.com/videos/example.mp4" },
    ]);

    const animation = parseRssEntry({
      guid: "gif-pin",
      description: '<img src="https://i.pinimg.com/originals/example.gif">',
    });
    expect(animation.mediaType).toBe("animation");
    expect(animation.mediaItems).toEqual([
      { type: "animation", url: "https://i.pinimg.com/originals/example.gif" },
    ]);
  });

  test("resolves empty RSS media from pin page fallback", async () => {
    globalThis.fetch = (async (url: URL | RequestInfo) => {
      if (String(url).includes("feed.rss")) {
        return new Response(`
          <rss>
            <channel>
              <item>
                <guid>empty-media-pin</guid>
                <link>https://ru.pinterest.com/pin/video/</link>
                <pubDate>Sat, 23 May 2026 05:32:51 GMT</pubDate>
                <description>&lt;img src=&quot;&quot;&gt;</description>
              </item>
            </channel>
          </rss>
        `, { status: 200 });
      }

      return new Response(`
        <html>
          <script>{"video":"https:\\/\\/v.pinimg.com\\/videos\\/clip.mp4"}</script>
        </html>
      `, { status: 200 });
    }) as unknown as typeof fetch;

    await expect(fetchAndStorePins()).resolves.toBe(1);
    const claimed = storage.claimNextPin();
    expect(claimed?.mediaType).toBe("video");
    expect(claimed?.mediaItems).toEqual([
      { type: "video", url: "https://v.pinimg.com/videos/clip.mp4" },
    ]);
  });

  test("upgrades RSS thumbnails to pin page animation media", async () => {
    globalThis.fetch = (async (url: URL | RequestInfo) => {
      if (String(url).includes("feed.rss")) {
        return new Response(`
          <rss>
            <channel>
              <item>
                <guid>gif-thumbnail-pin</guid>
                <link>https://ru.pinterest.com/pin/gif/</link>
                <description>&lt;img src=&quot;https://i.pinimg.com/236x/49/b5/d5/49b5d5ca20c0ff6ba08268a677160f1a.jpg&quot;&gt;</description>
              </item>
            </channel>
          </rss>
        `, { status: 200 });
      }

      return new Response(`
        <html>
          https:\\/\\/i.pinimg.com\\/originals\\/49\\/b5\\/d5\\/49b5d5ca20c0ff6ba08268a677160f1a.gif
          https:\\/\\/i.pinimg.com\\/upload\\/board_thumbnail.jpg
        </html>
      `, { status: 200 });
    }) as unknown as typeof fetch;

    await expect(fetchAndStorePins()).resolves.toBe(1);
    const claimed = storage.claimNextPin();
    expect(claimed?.mediaType).toBe("animation");
    expect(claimed?.mediaItems).toEqual([
      { type: "animation", url: "https://i.pinimg.com/originals/49/b5/d5/49b5d5ca20c0ff6ba08268a677160f1a.gif" },
    ]);
  });

  test("does not replace RSS media with unrelated pin page media", async () => {
    globalThis.fetch = (async (url: URL | RequestInfo) => {
      if (String(url).includes("feed.rss")) {
        return new Response(`
          <rss>
            <channel>
              <item>
                <guid>static-pin</guid>
                <link>https://ru.pinterest.com/pin/static/</link>
                <description>&lt;img src=&quot;https://i.pinimg.com/236x/aa/bb/cc/aabbcc.jpg&quot;&gt;</description>
              </item>
            </channel>
          </rss>
        `, { status: 200 });
      }

      return new Response(`
        <html>
          https:\\/\\/i.pinimg.com\\/originals\\/11\\/22\\/33\\/112233.gif
        </html>
      `, { status: 200 });
    }) as unknown as typeof fetch;

    await expect(fetchAndStorePins()).resolves.toBe(1);
    const claimed = storage.claimNextPin();
    expect(claimed?.mediaType).toBe("photo");
    expect(claimed?.mediaItems).toEqual([
      { type: "photo", url: "https://i.pinimg.com/originals/aa/bb/cc/aabbcc.jpg" },
    ]);
  });

  test("extracts and deduplicates mixed media from html", () => {
    expect(extractMediaFromHtml(`
      https:\\/\\/v.pinimg.com\\/videos\\/clip.mp4
      https://i.pinimg.com/236x/example.jpg
      https://i.pinimg.com/236x/example.jpg
    `)).toEqual([
      { type: "video", url: "https://v.pinimg.com/videos/clip.mp4" },
      { type: "photo", url: "https://i.pinimg.com/originals/example.jpg" },
    ]);
  });

  test("ignores Pinterest tracking gifs from non-media hosts", () => {
    expect(isContentMediaUrl("https://api-pinterest-com-eip-akadns-net.pinterest.com/_/_/r22.gif")).toBe(false);
    expect(isContentMediaUrl("https://i.pinimg.com/originals/aa/bb/cc/example.gif")).toBe(true);
    expect(extractMediaFromHtml(`
      https://api-pinterest-com-eip-akadns-net.pinterest.com/_/_/r22.gif
      https://pinimg-com-eip-akadns-net.pinimg.com/_/_/r21.gif
      https://www-pinterest-com-edgekey-net.pinterest.com/_/_/r20.gif
    `)).toEqual([]);
  });

  test("ignores Pinterest placeholder media", () => {
    expect(isContentMediaUrl("https://i.pinimg.com/originals/d5/3b/01/d53b014d86a6b6761bf649a0ed813c2b.png")).toBe(false);
    expect(extractMediaFromHtml(`
      https://i.pinimg.com/originals/d5/3b/01/d53b014d86a6b6761bf649a0ed813c2b.png
      https://i.pinimg.com/236x/d5/3b/01/d53b014d86a6b6761bf649a0ed813c2b.png
    `)).toEqual([]);
  });

  test("does not save short pin pages that only expose tracking gifs", async () => {
    let pinPageFetches = 0;
    globalThis.fetch = (async (url: URL | RequestInfo) => {
      if (String(url).includes("feed.rss")) {
        return new Response(`
          <rss>
            <channel>
              <item>
                <guid>https://ru.pinterest.com/pin/random-short/</guid>
                <link>https://ru.pinterest.com/pin/random-short/</link>
                <description>No RSS media here</description>
              </item>
            </channel>
          </rss>
        `, { status: 200 });
      }

      pinPageFetches++;
      return new Response(`
        <html>
          https:\\/\\/api-pinterest-com-eip-akadns-net.pinterest.com\\/_\\/_\\/r22.gif
          https:\\/\\/pinimg-com-eip-akadns-net.pinimg.com\\/_\\/_\\/r21.gif
        </html>
      `, { status: 200 });
    }) as unknown as typeof fetch;

    await expect(fetchAndStorePins()).resolves.toBe(0);
    expect(pinPageFetches).toBe(0);
    expect(storage.getStats().total).toBe(0);
  });

  test("deduplicates new pins by media url even when guid changes", async () => {
    globalThis.fetch = (async (url: URL | RequestInfo) => {
      if (String(url).includes("feed.rss")) {
        return new Response(`
          <rss>
            <channel>
              <item>
                <guid>https://ru.pinterest.com/pin/first/</guid>
                <link>https://ru.pinterest.com/pin/first/</link>
                <pubDate>Sat, 23 May 2026 05:32:51 GMT</pubDate>
                <description>&lt;img src=&quot;https://i.pinimg.com/236x/aa/bb/cc/aabbccddeeff00112233445566778899.jpg&quot;&gt;</description>
              </item>
              <item>
                <guid>https://ru.pinterest.com/pin/second/</guid>
                <link>https://ru.pinterest.com/pin/second/</link>
                <pubDate>Sat, 23 May 2026 05:33:51 GMT</pubDate>
                <description>&lt;img src=&quot;https://i.pinimg.com/236x/aa/bb/cc/aabbccddeeff00112233445566778899.jpg&quot;&gt;</description>
              </item>
            </channel>
          </rss>
        `, { status: 200 });
      }

      return new Response("<html></html>", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(fetchAndStorePins()).resolves.toBe(1);
    expect(storage.getStats().total).toBe(1);
  });
});

describe("publisher", () => {
  function bot(api: {
    sendPhoto?: () => Promise<void>;
    sendVideo?: () => Promise<void>;
    sendAnimation?: () => Promise<void>;
    sendMediaGroup?: () => Promise<void>;
  }) {
    return {
      api: {
        sendPhoto: api.sendPhoto ?? (async () => undefined),
        sendVideo: api.sendVideo ?? (async () => undefined),
        sendAnimation: api.sendAnimation ?? (async () => undefined),
        sendMediaGroup: api.sendMediaGroup ?? (async () => undefined),
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
    await expect(publishNextPin(bot({
      sendPhoto: async () => {
      sent++;
      },
    }) as never)).resolves.toBe(true);

    expect(calls).toEqual(["HEAD", "GET"]);
    expect(sent).toBe(1);
    expect(storage.getStats().done).toBe(1);
  });

  test("skips inaccessible images", async () => {
    storage.savePin(pin("a"));

    globalThis.fetch = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;

    await expect(publishNextPin(bot({
      sendPhoto: async () => {
        throw new Error("sendPhoto should not be called");
      },
    }) as never)).resolves.toBe(false);

    expect(storage.getStats().skipped).toBe(1);
  });

  test("skips invalid tracking gif media before sending", async () => {
    storage.savePin({
      ...pin("tracking"),
      imageUrl: "https://api-pinterest-com-eip-akadns-net.pinterest.com/_/_/r22.gif",
      mediaType: "animation",
      mediaItems: [{ type: "animation", url: "https://api-pinterest-com-eip-akadns-net.pinterest.com/_/_/r22.gif" }],
    });

    let fetches = 0;
    let sends = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(publishNextPin(bot({
      sendAnimation: async () => { sends++; },
    }) as never)).resolves.toBe(false);

    expect(fetches).toBe(0);
    expect(sends).toBe(0);
    expect(storage.getStats().skipped).toBe(1);
  });

  test("skips Pinterest placeholder media before sending", async () => {
    storage.savePin({
      ...pin("bad"),
      imageUrl: "https://i.pinimg.com/originals/d5/3b/01/d53b014d86a6b6761bf649a0ed813c2b.png",
      mediaItems: [{ type: "photo", url: "https://i.pinimg.com/originals/d5/3b/01/d53b014d86a6b6761bf649a0ed813c2b.png" }],
    });

    let fetches = 0;
    let sends = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(publishNextPin(bot({
      sendPhoto: async () => { sends++; },
    }) as never)).resolves.toBe(false);

    expect(fetches).toBe(0);
    expect(sends).toBe(0);
    expect(storage.getStats().skipped).toBe(1);
  });

  test("skips Telegram 400 and retries transient send failures", async () => {
    storage.savePin(pin("a"));
    storage.savePin(pin("b"));
    globalThis.fetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;

    await expect(publishNextPin(bot({
      sendPhoto: async () => {
        throw new GrammyError("Call failed", {
          ok: false,
          error_code: 400,
          description: "Bad Request: wrong file identifier",
        }, "sendPhoto", {});
      },
    }) as never)).resolves.toBe(false);
    expect(storage.getStats().skipped).toBe(1);

    await expect(publishNextPin(bot({
      sendPhoto: async () => {
        throw new Error("network down");
      },
    }) as never)).resolves.toBe(false);
    expect(storage.getStats().failed).toBe(1);
  });

  test("routes videos, animations, and carousels to matching Telegram APIs", async () => {
    globalThis.fetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;

    storage.savePin({
      ...pin("video"),
      imageUrl: "https://v.pinimg.com/videos/video.mp4",
      mediaType: "video",
      mediaItems: [{ type: "video", url: "https://v.pinimg.com/videos/video.mp4" }],
    });
    let videos = 0;
    await publishNextPin(bot({ sendVideo: async () => { videos++; } }) as never);
    expect(videos).toBe(1);

    storage.savePin({
      ...pin("gif"),
      imageUrl: "https://i.pinimg.com/originals/animation.gif",
      mediaType: "animation",
      mediaItems: [{ type: "animation", url: "https://i.pinimg.com/originals/animation.gif" }],
    });
    let animations = 0;
    await publishNextPin(bot({ sendAnimation: async () => { animations++; } }) as never);
    expect(animations).toBe(1);

    storage.savePin({
      ...pin("album"),
      imageUrl: "https://i.pinimg.com/originals/1.jpg",
      mediaType: "photo",
      mediaItems: [
        { type: "photo", url: "https://i.pinimg.com/originals/1.jpg" },
        { type: "video", url: "https://v.pinimg.com/videos/2.mp4" },
      ],
    });
    let mediaGroups = 0;
    await publishNextPin(bot({ sendMediaGroup: async () => { mediaGroups++; } }) as never);
    expect(mediaGroups).toBe(1);
  });

  test("publishes mixed animation carousels as the primary media only", async () => {
    globalThis.fetch = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;

    storage.savePin({
      ...pin("mixed"),
      imageUrl: "https://i.pinimg.com/originals/animation.gif",
      mediaType: "animation",
      mediaItems: [
        { type: "animation", url: "https://i.pinimg.com/originals/animation.gif" },
        { type: "photo", url: "https://i.pinimg.com/originals/photo.jpg" },
      ],
    });

    let animations = 0;
    let photos = 0;
    let mediaGroups = 0;
    await publishNextPin(bot({
      sendAnimation: async () => { animations++; },
      sendPhoto: async () => { photos++; },
      sendMediaGroup: async () => { mediaGroups++; },
    }) as never);

    expect(animations).toBe(1);
    expect(photos).toBe(0);
    expect(mediaGroups).toBe(0);
  });
});
