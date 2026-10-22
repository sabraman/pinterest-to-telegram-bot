# Specification: Ultra-Low RAM Rust Telegram Bot with `frankenstein`

## 1. Overview

This document specifies the design for replacing the Bun/TypeScript Pinterest-to-Telegram bot (`pinterest-to-telegram-bot`) with a high-efficiency, ultra-low memory Rust implementation using the `frankenstein` Telegram API client (`client-ureq`).

The primary optimization goal is **minimal RAM footprint (~3–5 MB RSS)** while maintaining complete feature parity:
- Reading Pinterest RSS feeds with HTML extraction and pin-page media enrichment.
- Managing an atomic, durable SQLite job queue with lease locking and failure retry policies.
- Publishing photos, videos, animations, and carousels directly to a Telegram channel.
- Processing Telegram bot commands (`/start`, `/help`, `/status`, `/force_publish`, `/clear`, `/reset_published`) with MSK ETA calculation.
- Dockerized deployment with persistent volume mounting for VPS hosting.

---

## 2. Architecture & Concurrency

A synchronous dual-threaded model is selected to eliminate runtime overhead (no Tokio runtime, no async machinery):

```
+-------------------------------------------------------------+
|                      Process (main)                         |
|                                                             |
|  +-----------------------+       +-----------------------+  |
|  |    Telegram Poller    |       | Background Scheduler  |  |
|  |  (frankenstein/ureq)  |       |  (RSS & Publisher)    |  |
|  +-----------+-----------+       +-----------+-----------+  |
|              |                               |              |
|              |    std::sync::mpsc::channel   |              |
|              +------------------------------>|              |
|              |      (force_publish sync)     |              |
|              |                               |              |
|              v                               v              |
|        +-------------------------------------------+        |
|        |      Arc<Mutex<rusqlite::Connection>>     |        |
|        |         (data/bot.sqlite in WAL)          |        |
|        +-------------------------------------------+        |
+-------------------------------------------------------------+
```

### 2.1 Threads
1. **Telegram Poller Thread (`TelegramPoller`)**:
   - Stack size explicitly capped at 512 KB (`std::thread::Builder::new().stack_size(512 * 1024)`).
   - Loops synchronously on `frankenstein::Api::get_updates` with 30s long-polling.
   - Handles commands, verifying admin permissions for protected actions.
   - For `/force_publish`, dispatches an event via `std::sync::mpsc::Sender<WorkerEvent>` to trigger an immediate publishing cycle.

2. **Background Scheduler Thread (`BackgroundScheduler`)**:
   - Stack size explicitly capped at 512 KB.
   - Uses `mpsc::Receiver::recv_timeout(...)` to block with zero CPU overhead.
   - Tracks intervals for:
     - RSS poller (`RSS_POLL_SECONDS`, default 180s)
     - Publisher worker (`PUBLISH_POLL_SECONDS`, default 900s)
   - Wakes up immediately upon receiving a `/force_publish` trigger or when a timer elapses.

3. **Shutdown Signal Handling**:
   - Catches `SIGINT` and `SIGTERM` via `ctrlc`.
   - Signals worker threads via an `AtomicBool` running flag and channel wakeup.
   - Gracefully finishes current pin publish before exiting.

---

## 3. Storage & Database Queue (`rusqlite`)

The database remains fully compatible with the existing SQLite schema in `data/bot.sqlite`.

### 3.1 PRAGMAs & Resource Bounds
- `PRAGMA journal_mode = WAL;` (Concurrent reads/writes without lock contention)
- `PRAGMA busy_timeout = 5000;` (Wait up to 5s on lock)
- `PRAGMA cache_size = -1000;` (Limits SQLite page cache to ~1 MB RAM)
- Single connection wrapped in `Arc<Mutex<rusqlite::Connection>>` to prevent redundant connection caches.

### 3.2 Schema
```sql
CREATE TABLE IF NOT EXISTS pins (
    guid TEXT PRIMARY KEY,
    image_url TEXT NOT NULL,
    media_type TEXT NOT NULL DEFAULT 'photo',
    media_items TEXT NOT NULL DEFAULT '[]',
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

CREATE INDEX IF NOT EXISTS idx_pins_status_created ON pins(status, created_at);
CREATE INDEX IF NOT EXISTS idx_pins_locked_until ON pins(locked_until);
```

### 3.3 Operations
- **`save_pin(pin)`**: `INSERT OR IGNORE INTO pins (...) VALUES (...)`.
- **`has_media_url(url, exclude_guid)`**: Deduplication check so duplicates with differing GUIDs are rejected.
- **`claim_next_pin()`**:
  - Atomic transaction finding the earliest pending pin:
    ```sql
    SELECT * FROM pins
    WHERE (image_url != '' OR media_items != '[]')
      AND attempts < ?
      AND (
        status = 'pending'
        OR (status = 'failed' AND (locked_until IS NULL OR locked_until <= ?))
        OR (status = 'processing' AND locked_until <= ?)
      )
    ORDER BY datetime(pub_date) ASC, datetime(created_at) ASC
    LIMIT 1;
    ```
  - Generates a UUID v4 `lock_token`, updates `status = 'processing'`, `attempts = attempts + 1`, and `locked_until = now + queue_lock_seconds`.
- **`mark_published(guid, token)`**: Updates status to `done`, `published = 1`, records `published_at = CURRENT_TIMESTAMP`, clears locks.
- **`mark_skipped(guid, token, reason)`**: Updates status to `skipped`, `published = 1`, logs reason.
- **`mark_failed(guid, token, error)`**: Updates status to `failed`, calculates retry exponential backoff (`locked_until = now + publish_retry_seconds` if attempts < max).
- **`get_stats()`**: Counts pins grouped by status.
- **`clear_storage()`**: Deletes all pins.
- **`reset_published()`**: Sets all pins back to `pending`, resets attempts and errors.

---

## 4. RSS Ingestion & Pinterest Scraping

### 4.1 Ingestion Flow
1. Fetch `PINTEREST_FEED` using `ureq::get(...)` with a 30s timeout and custom User-Agent `pinterest-to-telegram-bot/1.0`.
2. Stream-parse the feed using `quick-xml`:
   - Extracts `<item>` elements one by one.
   - Extracts `<guid>`, `<link>`, `<description>`, and `<pubDate>`.
3. Extract media from the decoded HTML in `<description>`:
   - Matches URLs ending in `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.mp4`, `.mov`, `.webm`.
   - Filters out non-content URLs (e.g. `/webapp/`, `/upload/`, `favicon`, `logo`, tracking pixels).
   - Filters out Pinterest placeholder gradient: `d53b014d86a6b6761bf649a0ed813c2b`.
   - Normalizes image URLs from `/\d+x\d*/` to `/originals/`.

### 4.2 Pin Page Enrichment Fallback
- If an item only has a thumbnail image or might contain high-res video/carousel:
  - Fetches the HTML from `pin.source_url` via `ureq`.
  - Scrapes full-resolution media URLs.
  - Upgrades `media_type` (`video`, `animation`, or `photo`) and sets `media_items`.

---

## 5. Publisher & Telegram Bot (`frankenstein`)

### 5.1 Publisher Logic
1. `claim_next_pin()` retrieves next job. If empty, exits.
2. **Preflight Check**:
   - Performs a `HEAD` request (fallback to `range: bytes=0-0` GET) using `ureq`.
   - If Pinterest returns 404/403 or invalid media, marks the pin as `skipped` to prevent queue deadlock.
3. **Telegram Forwarding**:
   - Direct URL transmission to Telegram (no media buffered into bot RAM).
   - Single Photo: `api.send_photo(...)`
   - Single Video: `api.send_video(...)`
   - Single Animation: `api.send_animation(...)`
   - Carousel (2–10 items): `api.send_media_group(...)`
4. Post-publish pause: `std::thread::sleep(Duration::from_millis(publish_send_delay_ms))` to avoid Telegram rate limits.

### 5.2 Command Handling
- `/start`: Greeting and command overview.
- `/help`: Detailed command list.
- `/status`: Returns total, pending, processing, done, failed, skipped pins, and formatted ETA to finish all pending pins in Moscow Time (Europe/Moscow MSK).
- `/force_publish`: (Admin only) Triggers immediate publish cycle.
- `/clear`: (Admin only) Deletes all stored pins.
- `/reset_published`: (Admin only) Resets all pins to pending.
- Catch-all: Directs user to `/help`.
- Admin notification: Sends `"Bot has been restarted"` to `ADMIN_ID` upon successful initialization.

---

## 6. Memory & Binary Optimization

1. **Thread Stacks**:
   - Worker and poller threads configured with 512 KB stacks.
2. **Cargo Profile**:
   ```toml
   [profile.release]
   opt-level = "z"
   lto = true
   codegen-units = 1
   panic = "abort"
   strip = true
   ```
3. **Crate Selection**:
   - HTTP: `ureq` (with `rustls` or native-tls) - lightweight synchronous client.
   - Telegram: `frankenstein` with `default-features = false, features = ["client-ureq"]`.
   - Database: `rusqlite` with `bundled` feature.
   - XML: `quick-xml`.
   - Serialization: `serde`, `serde_json`.
   - Time/Date: `chrono`, `chrono-tz` (for MSK timezone conversion).
   - Regex: `regex` with static `OnceLock`.

---

## 7. Docker & VPS Deployment

- **Dockerfile**: Multi-stage build on `rust:alpine` creating a static musl binary, final container based on `alpine:latest` with `ca-certificates`.
- **Docker Compose**: Maps `./data:/app/data`, loads `.env`, uses `restart: unless-stopped`.
- Survives system reboot automatically.

---

## 8. Verification & Testing Plan

1. **Unit Tests**:
   - In-memory SQLite tests validating queue transitions (`save_pin`, `claim_next_pin`, lease timeouts, `mark_published`, `mark_skipped`, `mark_failed`, `get_stats`).
   - URL parsing & filtering tests (placeholder detection, media type inference, URL normalization).
   - ETA formatting tests for Moscow time calculations.
2. **Integration Verification**:
   - Configuration loading and `.env` parsing.
   - RSS parsing against sample Pinterest feed XML.
   - End-to-end command routing simulation.
