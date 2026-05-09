import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { config } from "../config/env.ts";
import type { Pin, PinRecord, PinStatus, QueueStats } from "../types/index.ts";

mkdirSync(dirname(config.databasePath), { recursive: true });

const db = new Database(config.databasePath);

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec(`
  CREATE TABLE IF NOT EXISTS pins (
    guid TEXT PRIMARY KEY,
    image_url TEXT NOT NULL,
    source_url TEXT,
    pub_date TEXT NOT NULL,
    published INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_at TEXT,
    locked_until INTEGER,
    lock_token TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_pins_status_created
    ON pins(status, created_at);

  CREATE INDEX IF NOT EXISTS idx_pins_locked_until
    ON pins(locked_until);
`);

const columns = db
  .query<{ name: string }, []>("PRAGMA table_info(pins)")
  .all()
  .map((column) => column.name);

if (!columns.includes("lock_token")) {
  db.exec("ALTER TABLE pins ADD COLUMN lock_token TEXT");
}

interface PinRow {
  guid: string;
  image_url: string;
  source_url: string | null;
  pub_date: string;
  published: number;
  status: PinStatus;
  attempts: number;
  last_error: string | null;
  created_at: string;
  published_at: string | null;
  lock_token: string | null;
}

function mapPin(row: PinRow): PinRecord {
  return {
    guid: row.guid,
    imageUrl: row.image_url,
    sourceUrl: row.source_url ?? undefined,
    published: row.published === 1,
    pubDate: row.pub_date,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    lockToken: row.lock_token,
  };
}

export function closeStorage(): void {
  db.close();
}

export function savePin(pin: Pin): boolean {
  const result = db
    .query(`
      INSERT OR IGNORE INTO pins (guid, image_url, source_url, pub_date)
      VALUES ($guid, $imageUrl, $sourceUrl, $pubDate)
    `)
    .run({
      $guid: pin.guid,
      $imageUrl: pin.imageUrl,
      $sourceUrl: pin.sourceUrl ?? null,
      $pubDate: pin.pubDate,
    });

  return result.changes > 0;
}

export function clearStorage(): number {
  return db.query("DELETE FROM pins").run().changes;
}

export function resetPublished(): number {
  return db
    .query(`
      UPDATE pins
      SET published = 0,
          status = 'pending',
          attempts = 0,
          last_error = NULL,
          published_at = NULL,
          locked_until = NULL,
          lock_token = NULL
    `)
    .run().changes;
}

export function getStats(): QueueStats {
  const rows = db
    .query<{ status: PinStatus; count: number }, []>(`
      SELECT status, COUNT(*) AS count
      FROM pins
      GROUP BY status
    `)
    .all();

  const stats: QueueStats = {
    total: 0,
    pending: 0,
    processing: 0,
    done: 0,
    failed: 0,
    skipped: 0,
  };

  for (const row of rows) {
    stats[row.status] = row.count;
    stats.total += row.count;
  }

  return stats;
}

export function claimNextPin(): PinRecord | null {
  const claim = db.transaction(() => {
    const now = Math.floor(Date.now() / 1000);
    const lockedUntil = now + config.queueLockSeconds;
    const lockToken = crypto.randomUUID();

    const row = db
      .query<PinRow, [number, number, number]>(`
        SELECT *
        FROM pins
        WHERE image_url != ''
          AND attempts < ?
          AND (
            status = 'pending'
            OR (status = 'failed' AND (locked_until IS NULL OR locked_until <= ?))
            OR (status = 'processing' AND locked_until <= ?)
          )
        ORDER BY datetime(pub_date) ASC, datetime(created_at) ASC
        LIMIT 1
      `)
      .get(config.maxPublishAttempts, now, now);

    if (!row) return null;

    db.query(`
      UPDATE pins
      SET status = 'processing',
          attempts = attempts + 1,
          locked_until = $lockedUntil,
          lock_token = $lockToken
      WHERE guid = $guid
    `).run({
      $lockedUntil: lockedUntil,
      $lockToken: lockToken,
      $guid: row.guid,
    });

    const claimed = db
      .query<PinRow, [string]>("SELECT * FROM pins WHERE guid = ?")
      .get(row.guid);

    return claimed ? mapPin(claimed) : null;
  });

  return claim();
}

export function markPublished(guid: string, lockToken: string): boolean {
  const result = db.query(`
    UPDATE pins
    SET published = 1,
        status = 'done',
        last_error = NULL,
        published_at = CURRENT_TIMESTAMP,
        locked_until = NULL,
        lock_token = NULL
    WHERE guid = ?
      AND status = 'processing'
      AND lock_token = ?
  `).run(guid, lockToken);

  return result.changes > 0;
}

export function markSkipped(guid: string, lockToken: string, reason: string): boolean {
  const result = db.query(`
    UPDATE pins
    SET published = 1,
        status = 'skipped',
        last_error = ?,
        published_at = CURRENT_TIMESTAMP,
        locked_until = NULL,
        lock_token = NULL
    WHERE guid = ?
      AND status = 'processing'
      AND lock_token = ?
  `).run(reason, guid, lockToken);

  return result.changes > 0;
}

export function markFailed(guid: string, lockToken: string, error: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const retryAt = now + config.publishRetrySeconds;

  const result = db.query(`
    UPDATE pins
    SET status = 'failed',
        last_error = $error,
        locked_until = CASE WHEN attempts >= $maxAttempts THEN NULL ELSE $retryAt END,
        lock_token = NULL
    WHERE guid = $guid
      AND status = 'processing'
      AND lock_token = $lockToken
  `).run({
    $maxAttempts: config.maxPublishAttempts,
    $error: error.slice(0, 1000),
    $retryAt: retryAt,
    $guid: guid,
    $lockToken: lockToken,
  });

  return result.changes > 0;
}
