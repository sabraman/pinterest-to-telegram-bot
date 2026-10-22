# Frankenstein Rust Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the TypeScript/Bun Pinterest-to-Telegram bot with an ultra-low RAM (~3–5 MB RSS) synchronous Rust bot using the `frankenstein` Telegram API crate, `rusqlite`, and `quick-xml`.

**Architecture:** Dual-threaded synchronous architecture. A Telegram Poller thread runs long-polling (`get_updates`) and routes commands. A Background Scheduler thread handles RSS ingestion and queued publishing, sleeping on an `mpsc::channel` receiver to respond immediately to timer timeouts or `/force_publish` triggers. Shared SQLite connection wrapped in `Arc<Mutex<rusqlite::Connection>>`.

**Tech Stack:** Rust (2021 edition), `frankenstein` (client-ureq), `ureq`, `rusqlite` (bundled), `quick-xml`, `serde`, `serde_json`, `chrono`, `chrono-tz`, `ctrlc`, `uuid`.

## Global Constraints

- Synchronous execution only: No Tokio runtime or heavy async frameworks.
- Memory target: ~3–5 MB RSS at runtime, thread stacks explicitly set to 512 KB.
- User rule: Never build the project unless the user explicitly requests it.
- Database: Complete backward compatibility with existing `data/bot.sqlite` schema.

---

### Task 1: Project Initialization and Cargo Configuration

**Files:**
- Create: `Cargo.toml`
- Create: `src/main.rs`

**Interfaces:**
- Produces: Base project structure and dependency definitions.

- [ ] **Step 1: Create `Cargo.toml` with size & RAM optimized profile**

```toml
[package]
name = "pinterest-to-telegram-bot"
version = "0.1.0"
edition = "2021"

[dependencies]
frankenstein = { version = "0.52", default-features = false, features = ["client-ureq"] }
ureq = { version = "2.10", default-features = false, features = ["tls", "gzip", "json"] }
rusqlite = { version = "0.32", features = ["bundled"] }
quick-xml = "0.37"
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
chrono = { version = "0.4", features = ["serde"] }
chrono-tz = "0.10"
uuid = { version = "1.10", features = ["v4"] }
ctrlc = { version = "3.4", features = ["termination"] }
regex = "1.11"

[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

- [ ] **Step 2: Create minimal `src/main.rs` skeleton**

```rust
fn main() {
    println!("Pinterest-to-Telegram Rust Bot initializing...");
}
```

- [ ] **Step 3: Commit**

```bash
git add Cargo.toml src/main.rs
git commit -m "chore: initialize Rust cargo package with frankenstein and ureq"
```

---

### Task 2: Domain Types & Status Formatting

**Files:**
- Create: `src/types.rs`
- Create: `src/status.rs`
- Test: tests in `src/status.rs`

**Interfaces:**
- Produces: `MediaType`, `MediaItem`, `Pin`, `PinRecord`, `PinStatus`, `QueueStats` in `src/types.rs`.
- Produces: `format_queue_finish_eta`, `format_rss_parsed_message` in `src/status.rs`.

- [ ] **Step 1: Implement `src/types.rs`**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaType {
    Photo,
    Video,
    Animation,
}

impl Default for MediaType {
    fn default() -> Self {
        MediaType::Photo
    }
}

impl std::fmt::Display for MediaType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MediaType::Photo => write!(f, "photo"),
            MediaType::Video => write!(f, "video"),
            MediaType::Animation => write!(f, "animation"),
        }
    }
}

impl std::str::FromStr for MediaType {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "video" => Ok(MediaType::Video),
            "animation" => Ok(MediaType::Animation),
            _ => Ok(MediaType::Photo),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MediaItem {
    #[serde(rename = "type")]
    pub media_type: MediaType,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pin {
    pub guid: String,
    pub image_url: String,
    pub media_type: MediaType,
    pub media_items: Vec<MediaItem>,
    pub source_url: Option<String>,
    pub published: bool,
    pub pub_date: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PinStatus {
    Pending,
    Processing,
    Done,
    Failed,
    Skipped,
}

impl std::fmt::Display for PinStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PinStatus::Pending => write!(f, "pending"),
            PinStatus::Processing => write!(f, "processing"),
            PinStatus::Done => write!(f, "done"),
            PinStatus::Failed => write!(f, "failed"),
            PinStatus::Skipped => write!(f, "skipped"),
        }
    }
}

impl std::str::FromStr for PinStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "processing" => Ok(PinStatus::Processing),
            "done" => Ok(PinStatus::Done),
            "failed" => Ok(PinStatus::Failed),
            "skipped" => Ok(PinStatus::Skipped),
            _ => Ok(PinStatus::Pending),
        }
    }
}

#[derive(Debug, Clone)]
pub struct PinRecord {
    pub pin: Pin,
    pub status: PinStatus,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub created_at: String,
    pub published_at: Option<String>,
    pub locked_until: Option<i64>,
    pub lock_token: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct QueueStats {
    pub total: i64,
    pub pending: i64,
    pub processing: i64,
    pub done: i64,
    pub failed: i64,
    pub skipped: i64,
}
```

- [ ] **Step 2: Implement `src/status.rs` with unit tests for MSK ETA**

```rust
use chrono::{DateTime, Duration, Utc};
use chrono_tz::Europe::Moscow;

pub fn format_duration(total_seconds: i64) -> String {
    let days = total_seconds / 86_400;
    let hours = (total_seconds % 86_400) / 3_600;
    let minutes = ((total_seconds % 3_600) + 59) / 60;

    let mut parts = Vec::new();
    if days > 0 {
        parts.push(format!("{}d", days));
    }
    if hours > 0 {
        parts.push(format!("{}h", hours));
    }
    if minutes > 0 || parts.is_empty() {
        parts.push(format!("{}m", minutes));
    }

    parts.into_iter().take(2).collect::<Vec<_>>().join(" ")
}

pub fn format_queue_finish_eta(pending_pins: i64, publish_poll_seconds: i64, now: DateTime<Utc>) -> String {
    if pending_pins <= 0 {
        return "No pending pins".to_string();
    }

    let seconds_until_last_pin = pending_pins * publish_poll_seconds;
    let finish_at = now + Duration::seconds(seconds_until_last_pin);
    let msk_finish = finish_at.with_timezone(&Moscow);

    format!(
        "{}, {:02}:{:02} MSK ({} from now)",
        msk_finish.format("%Y-%m-%d"),
        msk_finish.format("%H"),
        msk_finish.format("%M"),
        format_duration(seconds_until_last_pin)
    )
}

pub fn format_rss_parsed_message(saved_pins: usize, pending_pins: i64, publish_poll_seconds: i64) -> String {
    format!(
        "RSS parsed. Saved {} new pins.\nLast pending pin ETA: {}",
        saved_pins,
        format_queue_finish_eta(pending_pins, publish_poll_seconds, Utc::now())
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn test_format_queue_finish_eta() {
        let base_time = Utc.with_ymd_and_hms(2026, 5, 10, 0, 0, 0).unwrap();
        // 3 pins * 900s = 2700s (45m). Moscow is UTC+3 => 03:45 MSK
        let eta = format_queue_finish_eta(3, 900, base_time);
        assert_eq!(eta, "2026-05-10, 03:45 MSK (45m from now)");
    }

    #[test]
    fn test_format_queue_finish_eta_empty() {
        let base_time = Utc.with_ymd_and_hms(2026, 5, 10, 0, 0, 0).unwrap();
        let eta = format_queue_finish_eta(0, 900, base_time);
        assert_eq!(eta, "No pending pins");
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/types.rs src/status.rs
git commit -m "feat: add domain types and status ETA formatting with tests"
```

---

### Task 3: Configuration Management

**Files:**
- Create: `src/config.rs`
- Test: tests in `src/config.rs`

**Interfaces:**
- Produces: `Config` struct with validation for all env variables.

- [ ] **Step 1: Implement `src/config.rs`**

```rust
use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    pub telegram_bot_token: String,
    pub telegram_channel_id: String,
    pub admin_id: i64,
    pub pinterest_rss_feed: String,
    pub database_path: String,
    pub rss_poll_seconds: u64,
    pub publish_poll_seconds: u64,
    pub publish_retry_seconds: i64,
    pub queue_lock_seconds: i64,
    pub max_publish_attempts: i64,
    pub fetch_timeout_seconds: u64,
    pub publish_send_delay_ms: u64,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let telegram_bot_token = env::var("TELEGRAM_BOT_TOKEN")
            .map(|s| s.trim().to_string())
            .map_err(|_| "TELEGRAM_BOT_TOKEN is not set".to_string())?;

        let telegram_channel_id = env::var("TELEGRAM_CHANNEL_ID")
            .map(|s| s.trim().replace(['\'', '"'], ""))
            .map_err(|_| "TELEGRAM_CHANNEL_ID is not set".to_string())?;

        let admin_id = env::var("ADMIN_ID")
            .map_err(|_| "ADMIN_ID is not set".to_string())?
            .trim()
            .parse::<i64>()
            .map_err(|_| "ADMIN_ID must be a valid integer".to_string())?;

        let pinterest_rss_feed = env::var("PINTEREST_FEED")
            .map(|s| s.trim().to_string())
            .map_err(|_| "PINTEREST_FEED is not set".to_string())?;

        let database_path = env::var("DATABASE_PATH")
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| "data/bot.sqlite".to_string());

        let rss_poll_seconds = env::var("RSS_POLL_SECONDS")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(180);

        let publish_poll_seconds = env::var("PUBLISH_POLL_SECONDS")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(900);

        let publish_retry_seconds = env::var("PUBLISH_RETRY_SECONDS")
            .ok()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .unwrap_or(300);

        let queue_lock_seconds = env::var("QUEUE_LOCK_SECONDS")
            .ok()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .unwrap_or(120);

        let max_publish_attempts = env::var("MAX_PUBLISH_ATTEMPTS")
            .ok()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .unwrap_or(5);

        let fetch_timeout_seconds = env::var("FETCH_TIMEOUT_SECONDS")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(30);

        let publish_send_delay_ms = env::var("PUBLISH_SEND_DELAY_MS")
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(1000);

        Ok(Config {
            telegram_bot_token,
            telegram_channel_id,
            admin_id,
            pinterest_rss_feed,
            database_path,
            rss_poll_seconds,
            publish_poll_seconds,
            publish_retry_seconds,
            queue_lock_seconds,
            max_publish_attempts,
            fetch_timeout_seconds,
            publish_send_delay_ms,
        })
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/config.rs
git commit -m "feat: implement strongly-typed configuration loader"
```

---

### Task 4: Storage & SQLite Queue Management

**Files:**
- Create: `src/storage.rs`
- Test: tests in `src/storage.rs`

**Interfaces:**
- Produces: `Storage` struct wrapping `Arc<Mutex<rusqlite::Connection>>` with `save_pin`, `claim_next_pin`, `mark_published`, `mark_skipped`, `mark_failed`, `get_stats`, `clear_storage`, `reset_published`.

- [ ] **Step 1: Implement `src/storage.rs`**

```rust
use crate::config::Config;
use crate::types::{MediaItem, MediaType, Pin, PinRecord, PinStatus, QueueStats};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Result};
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use uuid::Uuid;

#[derive(Clone)]
pub struct Storage {
    conn: Arc<Mutex<Connection>>,
    config: Arc<Config>,
}

impl Storage {
    pub fn open(config: Arc<Config>) -> Result<Self> {
        if let Some(parent) = Path::new(&config.database_path).parent() {
            let _ = fs::create_dir_all(parent);
        }

        let conn = Connection::open(&config.database_path)?;
        Self::configure_db(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            config,
        })
    }

    #[cfg(test)]
    pub fn open_in_memory(config: Arc<Config>) -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::configure_db(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            config,
        })
    }

    fn configure_db(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA cache_size = -1000;
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
             CREATE INDEX IF NOT EXISTS idx_pins_locked_until ON pins(locked_until);",
        )?;
        Ok(())
    }

    pub fn save_pin(&self, pin: &Pin) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let media_items_json = serde_json::to_string(&pin.media_items).unwrap_or_else(|_| "[]".to_string());
        let count = conn.execute(
            "INSERT OR IGNORE INTO pins (guid, image_url, media_type, media_items, source_url, pub_date)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                pin.guid,
                pin.image_url,
                pin.media_type.to_string(),
                media_items_json,
                pin.source_url,
                pin.pub_date,
            ],
        )?;
        Ok(count > 0)
    }

    pub fn has_media_url(&self, media_url: &str, exclude_guid: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let found: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM pins WHERE image_url = ?1 AND guid != ?2 LIMIT 1",
                params![media_url, exclude_guid],
                |row| row.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }

    pub fn get_pin(&self, guid: &str) -> Result<Option<PinRecord>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT guid, image_url, media_type, media_items, source_url, pub_date,
                    published, status, attempts, last_error, created_at, published_at,
                    locked_until, lock_token
             FROM pins WHERE guid = ?1",
            params![guid],
            Self::map_row,
        )
        .optional()
    }

    pub fn update_queued_pin_media(&self, pin: &Pin) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let media_items_json = serde_json::to_string(&pin.media_items).unwrap_or_else(|_| "[]".to_string());
        let count = conn.execute(
            "UPDATE pins
             SET image_url = ?1,
                 media_type = ?2,
                 media_items = ?3,
                 source_url = COALESCE(?4, source_url)
             WHERE guid = ?5
               AND published = 0
               AND status IN ('pending', 'failed')",
            params![
                pin.image_url,
                pin.media_type.to_string(),
                media_items_json,
                pin.source_url,
                pin.guid,
            ],
        )?;
        Ok(count > 0)
    }

    pub fn claim_next_pin(&self) -> Result<Option<PinRecord>> {
        let mut conn = self.conn.lock().unwrap();
        let now = Utc::now().timestamp();
        let locked_until = now + self.config.queue_lock_seconds;
        let lock_token = Uuid::new_v4().to_string();

        let tx = conn.transaction()?;
        let target_guid: Option<String> = tx
            .query_row(
                "SELECT guid FROM pins
                 WHERE (image_url != '' OR media_items != '[]')
                   AND attempts < ?1
                   AND (
                     status = 'pending'
                     OR (status = 'failed' AND (locked_until IS NULL OR locked_until <= ?2))
                     OR (status = 'processing' AND locked_until <= ?3)
                   )
                 ORDER BY datetime(pub_date) ASC, datetime(created_at) ASC
                 LIMIT 1",
                params![self.config.max_publish_attempts, now, now],
                |row| row.get(0),
            )
            .optional()?;

        let guid = match target_guid {
            Some(g) => g,
            None => return Ok(None),
        };

        tx.execute(
            "UPDATE pins
             SET status = 'processing',
                 attempts = attempts + 1,
                 locked_until = ?1,
                 lock_token = ?2
             WHERE guid = ?3",
            params![locked_until, lock_token, guid],
        )?;

        let claimed = tx.query_row(
            "SELECT guid, image_url, media_type, media_items, source_url, pub_date,
                    published, status, attempts, last_error, created_at, published_at,
                    locked_until, lock_token
             FROM pins WHERE guid = ?1",
            params![guid],
            Self::map_row,
        )?;

        tx.commit()?;
        Ok(Some(claimed))
    }

    pub fn mark_published(&self, guid: &str, lock_token: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let count = conn.execute(
            "UPDATE pins
             SET published = 1,
                 status = 'done',
                 last_error = NULL,
                 published_at = CURRENT_TIMESTAMP,
                 locked_until = NULL,
                 lock_token = NULL
             WHERE guid = ?1
               AND status = 'processing'
               AND lock_token = ?2",
            params![guid, lock_token],
        )?;
        Ok(count > 0)
    }

    pub fn mark_skipped(&self, guid: &str, lock_token: &str, reason: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let count = conn.execute(
            "UPDATE pins
             SET published = 1,
                 status = 'skipped',
                 last_error = ?1,
                 published_at = CURRENT_TIMESTAMP,
                 locked_until = NULL,
                 lock_token = NULL
             WHERE guid = ?2
               AND status = 'processing'
               AND lock_token = ?3",
            params![reason, guid, lock_token],
        )?;
        Ok(count > 0)
    }

    pub fn mark_failed(&self, guid: &str, lock_token: &str, error: &str) -> Result<bool> {
        let conn = self.conn.lock().unwrap();
        let now = Utc::now().timestamp();
        let retry_at = now + self.config.publish_retry_seconds;
        let count = conn.execute(
            "UPDATE pins
             SET status = 'failed',
                 last_error = ?1,
                 locked_until = CASE WHEN attempts >= ?2 THEN NULL ELSE ?3 END,
                 lock_token = NULL
             WHERE guid = ?4
               AND status = 'processing'
               AND lock_token = ?5",
            params![error, self.config.max_publish_attempts, retry_at, guid, lock_token],
        )?;
        Ok(count > 0)
    }

    pub fn clear_storage(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let count = conn.execute("DELETE FROM pins", [])?;
        Ok(count)
    }

    pub fn reset_published(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let count = conn.execute(
            "UPDATE pins
             SET published = 0,
                 status = 'pending',
                 attempts = 0,
                 last_error = NULL,
                 published_at = NULL,
                 locked_until = NULL,
                 lock_token = NULL",
            [],
        )?;
        Ok(count)
    }

    pub fn get_stats(&self) -> Result<QueueStats> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT status, COUNT(*) FROM pins GROUP BY status")?;
        let rows = stmt.query_map([], |row| {
            let status_str: String = row.get(0)?;
            let count: i64 = row.get(1)?;
            Ok((status_str, count))
        })?;

        let mut stats = QueueStats::default();
        for item in rows {
            let (status_str, count) = item?;
            match status_str.to_lowercase().as_str() {
                "pending" => stats.pending = count,
                "processing" => stats.processing = count,
                "done" => stats.done = count,
                "failed" => stats.failed = count,
                "skipped" => stats.skipped = count,
                _ => {}
            }
            stats.total += count;
        }
        Ok(stats)
    }

    fn map_row(row: &rusqlite::Row) -> Result<PinRecord> {
        let guid: String = row.get(0)?;
        let image_url: String = row.get(1)?;
        let media_type_str: String = row.get(2)?;
        let media_items_raw: String = row.get(3)?;
        let source_url: Option<String> = row.get(4)?;
        let pub_date: String = row.get(5)?;
        let published_int: i64 = row.get(6)?;
        let status_str: String = row.get(7)?;
        let attempts: i64 = row.get(8)?;
        let last_error: Option<String> = row.get(9)?;
        let created_at: String = row.get(10)?;
        let published_at: Option<String> = row.get(11)?;
        let locked_until: Option<i64> = row.get(12)?;
        let lock_token: Option<String> = row.get(13)?;

        let media_type = media_type_str.parse().unwrap_or(MediaType::Photo);
        let media_items: Vec<MediaItem> = serde_json::from_str(&media_items_raw).unwrap_or_else(|_| {
            if !image_url.is_empty() {
                vec![MediaItem {
                    media_type,
                    url: image_url.clone(),
                }]
            } else {
                Vec::new()
            }
        });

        let status = status_str.parse().unwrap_or(PinStatus::Pending);

        Ok(PinRecord {
            pin: Pin {
                guid,
                image_url,
                media_type,
                media_items,
                source_url,
                published: published_int == 1,
                pub_date,
            },
            status,
            attempts,
            last_error,
            created_at,
            published_at,
            locked_until,
            lock_token,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock_config() -> Arc<Config> {
        Arc::new(Config {
            telegram_bot_token: "test".to_string(),
            telegram_channel_id: "test".to_string(),
            admin_id: 1,
            pinterest_rss_feed: "test".to_string(),
            database_path: ":memory:".to_string(),
            rss_poll_seconds: 180,
            publish_poll_seconds: 900,
            publish_retry_seconds: 300,
            queue_lock_seconds: 120,
            max_publish_attempts: 2,
            fetch_timeout_seconds: 30,
            publish_send_delay_ms: 1000,
        })
    }

    #[test]
    fn test_save_and_claim_flow() {
        let storage = Storage::open_in_memory(mock_config()).unwrap();
        let pin = Pin {
            guid: "test-guid-1".to_string(),
            image_url: "https://i.pinimg.com/originals/1.jpg".to_string(),
            media_type: MediaType::Photo,
            media_items: vec![MediaItem {
                media_type: MediaType::Photo,
                url: "https://i.pinimg.com/originals/1.jpg".to_string(),
            }],
            source_url: Some("https://pinterest.com/pin/1".to_string()),
            published: false,
            pub_date: "2026-01-01T00:00:00Z".to_string(),
        };

        assert!(storage.save_pin(&pin).unwrap());
        assert!(!storage.save_pin(&pin).unwrap()); // idempotent

        let stats = storage.get_stats().unwrap();
        assert_eq!(stats.total, 1);
        assert_eq!(stats.pending, 1);

        let claimed = storage.claim_next_pin().unwrap().expect("should claim pin");
        assert_eq!(claimed.pin.guid, "test-guid-1");
        assert_eq!(claimed.status, PinStatus::Processing);
        let token = claimed.lock_token.unwrap();

        assert!(storage.mark_published("test-guid-1", &token).unwrap());
        let stats_after = storage.get_stats().unwrap();
        assert_eq!(stats_after.done, 1);
        assert_eq!(stats_after.pending, 0);
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/storage.rs
git commit -m "feat: implement SQLite persistent queue storage with tests"
```

---

### Task 5: Pinterest Media Scraper & Utilities

**Files:**
- Create: `src/scraper.rs`
- Test: tests in `src/scraper.rs`

**Interfaces:**
- Produces: `is_content_media_url`, `media_type_from_url`, `extract_media_from_html`, `normalize_pinterest_image`, `unique_media_items`, `resolve_pin_page_media`.

- [ ] **Step 1: Implement `src/scraper.rs`**

```rust
use crate::types::{MediaItem, MediaType};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

static URL_MEDIA_RE: OnceLock<Regex> = OnceLock::new();
static BLOCKED_IDS: OnceLock<HashSet<&'static str>> = OnceLock::new();

fn get_url_media_re() -> &'static Regex {
    URL_MEDIA_RE.get_or_init(|| {
        Regex::new(r#"(?i)https?://[^"'\\<>\s]+?\.(?:jpe?g|png|webp|gif|mp4|mov|webm)(?:\?[^"'\\<>\s]*)?"#).unwrap()
    })
}

fn get_blocked_ids() -> &'static HashSet<&'static str> {
    BLOCKED_IDS.get_or_init(|| {
        let mut set = HashSet::new();
        set.insert("d53b014d86a6b6761bf649a0ed813c2b");
        set
    })
}

pub fn media_type_from_url(url: &str) -> MediaType {
    let clean = url.split('?').next().unwrap_or(url).to_lowercase();
    if clean.ends_with(".gif") {
        MediaType::Animation
    } else if clean.ends_with(".mp4") || clean.ends_with(".mov") || clean.ends_with(".webm") {
        MediaType::Video
    } else {
        MediaType::Photo
    }
}

pub fn media_identity(url: &str) -> String {
    let clean = url.split('?').next().unwrap_or(url);
    if let Some(filename) = clean.split('/').last() {
        if let Some(pos) = filename.rfind('.') {
            return filename[..pos].to_string();
        }
        return filename.to_string();
    }
    url.to_string()
}

pub fn normalize_pinterest_image(url: &str) -> String {
    let no_spaces: String = url.chars().filter(|c| !c.is_whitespace()).collect();
    static REGEX: OnceLock<Regex> = OnceLock::new();
    let re = REGEX.get_or_init(|| Regex::new(r"/\d+x\d*/").unwrap());
    re.replace(&no_spaces, "/originals/").to_string()
}

pub fn is_content_media_url(url: &str) -> bool {
    let lower = url.to_lowercase();
    if !lower.contains("i.pinimg.com") && !lower.contains("v.pinimg.com") {
        return false;
    }

    if lower.contains("/webapp/")
        || lower.contains("/upload/")
        || lower.contains("/_/_/")
        || lower.contains("_rs/")
        || lower.contains("favicon")
        || lower.contains("logo")
    {
        return false;
    }

    let id = media_identity(&lower);
    if get_blocked_ids().contains(id.as_str()) {
        return false;
    }

    true
}

fn media_rank(media_type: MediaType) -> u8 {
    match media_type {
        MediaType::Video => 3,
        MediaType::Animation => 2,
        MediaType::Photo => 1,
    }
}

pub fn unique_media_items(items: Vec<MediaItem>) -> Vec<MediaItem> {
    let mut map: HashMap<String, MediaItem> = HashMap::new();
    for item in items {
        if item.url.is_empty() {
            continue;
        }
        let identity = media_identity(&item.url);
        if let Some(existing) = map.get(&identity) {
            if media_rank(item.media_type) > media_rank(existing.media_type) {
                map.insert(identity, item);
            }
        } else {
            map.insert(identity, item);
        }
    }
    map.into_values().collect()
}

pub fn decode_html(val: &str) -> String {
    val.replace("&quot;", "\"")
        .replace("&#34;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("\\u002F", "/")
        .replace("\\/", "/")
}

pub fn extract_media_from_html(html: &str) -> Vec<MediaItem> {
    let decoded = decode_html(html);
    let re = get_url_media_re();

    let items: Vec<MediaItem> = re
        .find_iter(&decoded)
        .map(|m| m.as_str())
        .filter(|url| is_content_media_url(url))
        .map(|url| {
            let mtype = media_type_from_url(url);
            MediaItem {
                media_type: mtype,
                url: if mtype == MediaType::Photo {
                    normalize_pinterest_image(url)
                } else {
                    url.to_string()
                },
            }
        })
        .collect();

    unique_media_items(items)
}

pub fn resolve_pin_page_media(pin_url: &str, timeout_secs: u64) -> Result<Vec<MediaItem>, String> {
    let response = ureq::get(pin_url)
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .set("User-Agent", "pinterest-to-telegram-bot/1.0")
        .set("Accept", "text/html")
        .call()
        .map_err(|e| format!("Pinterest pin page fetch error: {}", e))?;

    let html = response
        .into_string()
        .map_err(|e| format!("Failed to read pin page body: {}", e))?;

    Ok(extract_media_from_html(&html))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_blocked_placeholder_is_rejected() {
        let blocked = "https://i.pinimg.com/originals/d5/3b/01/d53b014d86a6b6761bf649a0ed813c2b.jpg";
        assert!(!is_content_media_url(blocked));
    }

    #[test]
    fn test_valid_image_url_normalization() {
        let raw = "https://i.pinimg.com/236x/ab/cd/ef/abcdef12345.jpg";
        assert!(is_content_media_url(raw));
        assert_eq!(
            normalize_pinterest_image(raw),
            "https://i.pinimg.com/originals/ab/cd/ef/abcdef12345.jpg"
        );
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/scraper.rs
git commit -m "feat: implement Pinterest media scraper and normalization"
```

---

### Task 6: RSS Feed Ingestion & Enrichment

**Files:**
- Create: `src/rss.rs`
- Test: tests in `src/rss.rs`

**Interfaces:**
- Produces: `fetch_and_store_pins(config, storage) -> Result<usize, String>`.

- [ ] **Step 1: Implement `src/rss.rs` using streaming `quick-xml`**

```rust
use crate::config::Config;
use crate::scraper::{
    decode_html, extract_media_from_html, media_identity, normalize_pinterest_image,
    resolve_pin_page_media, unique_media_items,
};
use crate::storage::Storage;
use crate::types::{MediaItem, MediaType, Pin};
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use regex::Regex;
use std::collections::HashSet;
use std::sync::{Arc, OnceLock};

pub fn parse_rss_xml(xml: &str) -> Vec<Pin> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut pins = Vec::new();
    let mut in_item = false;
    let mut current_tag = String::new();

    let mut guid = String::new();
    let mut link = String::new();
    let mut description = String::new();
    let mut pub_date = String::new();

    let mut buf = Vec::new();

    while let Ok(event) = reader.read_event_into(&mut buf) {
        match event {
            Event::Start(e) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name.eq_ignore_ascii_case("item") || name.eq_ignore_ascii_case("entry") {
                    in_item = true;
                    guid.clear();
                    link.clear();
                    description.clear();
                    pub_date.clear();
                } else if in_item {
                    current_tag = name;
                }
            }
            Event::Text(e) => {
                if in_item {
                    let text = e.unescape().unwrap_or_default().to_string();
                    match current_tag.to_lowercase().as_str() {
                        "guid" | "id" => guid.push_str(&text),
                        "link" => link.push_str(&text),
                        "description" | "content" | "summary" => description.push_str(&text),
                        "pubdate" | "published" | "updated" => pub_date.push_str(&text),
                        _ => {}
                    }
                }
            }
            Event::End(e) => {
                let name = String::from_utf8_lossy(e.name().as_ref());
                if name.eq_ignore_ascii_case("item") || name.eq_ignore_ascii_case("entry") {
                    in_item = false;
                    let decoded_desc = decode_html(&description);
                    let mut media_items = extract_media_from_html(&decoded_desc);

                    // Additional regex check for src attributes
                    static SRC_RE: OnceLock<Regex> = OnceLock::new();
                    let src_re = SRC_RE.get_or_init(|| Regex::new(r#"src=["']([^"']+)["']"#).unwrap());
                    for cap in src_re.captures_iter(&decoded_desc) {
                        if let Some(src) = cap.get(1) {
                            let url = src.as_str().replace(char::is_whitespace, "");
                            if crate::scraper::is_content_media_url(&url) {
                                let mtype = crate::scraper::media_type_from_url(&url);
                                media_items.push(MediaItem {
                                    media_type: mtype,
                                    url: if mtype == MediaType::Photo {
                                        normalize_pinterest_image(&url)
                                    } else {
                                        url
                                    },
                                });
                            }
                        }
                    }

                    let unique_items = unique_media_items(media_items);
                    let primary_media = unique_items.first();

                    let effective_guid = if !guid.is_empty() {
                        guid.clone()
                    } else if !link.is_empty() {
                        link.clone()
                    } else if let Some(m) = primary_media {
                        m.url.clone()
                    } else {
                        String::new()
                    };

                    let image_url = primary_media.map(|m| m.url.clone()).unwrap_or_default();
                    let media_type = primary_media.map(|m| m.media_type).unwrap_or(MediaType::Photo);

                    pins.push(Pin {
                        guid: effective_guid,
                        image_url,
                        media_type,
                        media_items: unique_items,
                        source_url: if link.is_empty() { None } else { Some(link.clone()) },
                        published: false,
                        pub_date: pub_date.clone(),
                    });
                }
                current_tag.clear();
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    pins
}

pub fn fetch_and_store_pins(config: &Config, storage: &Storage) -> Result<usize, String> {
    println!("Downloading Pinterest RSS feed...");
    let response = ureq::get(&config.pinterest_rss_feed)
        .timeout(std::time::Duration::from_secs(config.fetch_timeout_seconds))
        .set("User-Agent", "pinterest-to-telegram-bot/1.0")
        .call()
        .map_err(|e| format!("Pinterest RSS returned error: {}", e))?;

    let xml = response
        .into_string()
        .map_err(|e| format!("Failed to read RSS body: {}", e))?;

    let entries = parse_rss_xml(&xml);
    let mut saved = 0;
    let mut skipped = 0;

    for mut pin in entries {
        if pin.guid.is_empty() {
            skipped += 1;
            continue;
        }

        let existing_pin = storage.get_pin(&pin.guid).unwrap_or(None);
        let should_enrich = match &existing_pin {
            None => true,
            Some(p) => {
                (p.status == crate::types::PinStatus::Pending || p.status == crate::types::PinStatus::Failed)
                    && p.pin.media_type == MediaType::Photo
            }
        };

        if should_enrich {
            if let Some(source_url) = &pin.source_url {
                if let Ok(resolved_media) = resolve_pin_page_media(source_url, config.fetch_timeout_seconds) {
                    let rss_identities: HashSet<String> = pin.media_items.iter().map(|i| media_identity(&i.url)).collect();
                    let matching_resolved: Vec<MediaItem> = resolved_media
                        .into_iter()
                        .filter(|item| rss_identities.contains(&media_identity(&item.url)))
                        .collect();

                    let mut combined = matching_resolved;
                    combined.extend(pin.media_items);
                    let enriched = unique_media_items(combined);
                    if let Some(primary) = enriched.first() {
                        pin.media_type = primary.media_type;
                        pin.image_url = primary.url.clone();
                        pin.media_items = enriched;
                    }
                }
            }
        }

        if pin.media_items.is_empty() || pin.image_url.is_empty() {
            skipped += 1;
            continue;
        }

        if existing_pin.is_some() {
            let _ = storage.update_queued_pin_media(&pin);
            continue;
        }

        if storage.has_media_url(&pin.image_url, &pin.guid).unwrap_or(false) {
            skipped += 1;
            continue;
        }

        if storage.save_pin(&pin).unwrap_or(false) {
            saved += 1;
        }
    }

    println!("RSS parsed: {} saved, {} skipped", saved, skipped);
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_rss_sample() {
        let sample_xml = r#"
        <rss version="2.0">
            <channel>
                <item>
                    <guid>https://www.pinterest.com/pin/12345/</guid>
                    <link>https://www.pinterest.com/pin/12345/</link>
                    <description>&lt;img src="https://i.pinimg.com/originals/12/34/56/123456789.jpg" /&gt;</description>
                    <pubDate>Mon, 01 Jan 2026 00:00:00 +0000</pubDate>
                </item>
            </channel>
        </rss>"#;

        let pins = parse_rss_xml(sample_xml);
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].guid, "https://www.pinterest.com/pin/12345/");
        assert_eq!(pins[0].image_url, "https://i.pinimg.com/originals/12/34/56/123456789.jpg");
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/rss.rs
git commit -m "feat: implement streaming RSS parser with pin page enrichment fallback"
```

---

### Task 7: Publisher & Media Forwarding (`frankenstein`)

**Files:**
- Create: `src/publisher.rs`

**Interfaces:**
- Produces: `publish_next_pin(api, config, storage) -> Result<bool, String>`.

- [ ] **Step 1: Implement `src/publisher.rs`**

```rust
use crate::config::Config;
use crate::scraper::is_content_media_url;
use crate::storage::Storage;
use crate::types::{MediaItem, MediaType};
use frankenstein::{
    Api, InputMedia, InputMediaPhoto, InputMediaVideo, SendAnimationParams, SendMediaGroupParams,
    SendMessageParams, SendPhotoParams, SendVideoParams, TelegramApi,
};
use std::thread::sleep;
use std::time::Duration;

pub fn assert_media_available(url: &str, timeout_secs: u64) -> Result<(), String> {
    let timeout = Duration::from_secs(timeout_secs);
    let head_res = ureq::head(url)
        .timeout(timeout)
        .set("User-Agent", "pinterest-to-telegram-bot/1.0")
        .call();

    if let Ok(res) = head_res {
        if res.status() < 400 {
            return Ok(());
        }
    }

    let range_res = ureq::get(url)
        .timeout(timeout)
        .set("User-Agent", "pinterest-to-telegram-bot/1.0")
        .set("Range", "bytes=0-0")
        .call()
        .map_err(|e| format!("Media returned HTTP error: {}", e))?;

    if range_res.status() < 400 {
        Ok(())
    } else {
        Err(format!("Media returned HTTP {}", range_res.status()))
    }
}

pub fn send_media(api: &Api, channel_id: &str, media_items: &[MediaItem]) -> Result<(), String> {
    if media_items.is_empty() {
        return Err("Pin has no media items".to_string());
    }

    if media_items.len() > 1 && media_items.iter().all(|i| i.media_type == MediaType::Photo || i.media_type == MediaType::Video) {
        let group: Vec<InputMedia> = media_items
            .iter()
            .take(10)
            .map(|item| {
                if item.media_type == MediaType::Video {
                    InputMedia::Video(InputMediaVideo::builder().media(item.url.clone()).build())
                } else {
                    InputMedia::Photo(InputMediaPhoto::builder().media(item.url.clone()).build())
                }
            })
            .collect();

        let params = SendMediaGroupParams::builder()
            .chat_id(channel_id.to_string())
            .media(group)
            .build();

        api.send_media_group(&params)
            .map_err(|e| format!("Failed to send media group: {:?}", e))?;
        return Ok(());
    }

    let item = &media_items[0];
    match item.media_type {
        MediaType::Video => {
            let params = SendVideoParams::builder()
                .chat_id(channel_id.to_string())
                .video(item.url.clone())
                .build();
            api.send_video(&params)
                .map_err(|e| format!("Failed to send video: {:?}", e))?;
        }
        MediaType::Animation => {
            let params = SendAnimationParams::builder()
                .chat_id(channel_id.to_string())
                .animation(item.url.clone())
                .build();
            api.send_animation(&params)
                .map_err(|e| format!("Failed to send animation: {:?}", e))?;
        }
        MediaType::Photo => {
            let params = SendPhotoParams::builder()
                .chat_id(channel_id.to_string())
                .photo(item.url.clone())
                .build();
            api.send_photo(&params)
                .map_err(|e| format!("Failed to send photo: {:?}", e))?;
        }
    }

    Ok(())
}

pub fn publish_next_pin(api: &Api, config: &Config, storage: &Storage) -> Result<bool, String> {
    let pin_record = match storage.claim_next_pin() {
        Ok(Some(record)) => record,
        Ok(None) => {
            println!("Publish queue is empty");
            return Ok(false);
        }
        Err(e) => return Err(format!("Storage error claiming pin: {}", e)),
    };

    let pin = pin_record.pin;
    let lock_token = pin_record.lock_token.unwrap_or_default();
    println!("Publishing pin {} (attempt {})", pin.guid, pin_record.attempts);

    let media_to_publish = if pin.media_items.iter().all(|i| i.media_type == MediaType::Photo || i.media_type == MediaType::Video) {
        pin.media_items.into_iter().take(10).collect::<Vec<_>>()
    } else {
        pin.media_items.into_iter().take(1).collect::<Vec<_>>()
    };

    for item in &media_to_publish {
        if !is_content_media_url(&item.url) {
            let err = format!("Invalid Pinterest media URL: {}", item.url);
            let _ = storage.mark_skipped(&pin.guid, &lock_token, &err);
            return Ok(false);
        }

        if let Err(e) = assert_media_available(&item.url, config.fetch_timeout_seconds) {
            let _ = storage.mark_skipped(&pin.guid, &lock_token, &e);
            return Ok(false);
        }
    }

    match send_media(api, &config.telegram_channel_id, &media_to_publish) {
        Ok(_) => {
            let _ = storage.mark_published(&pin.guid, &lock_token);
            println!("Published pin {}", pin.guid);
            sleep(Duration::from_millis(config.publish_send_delay_ms));
            Ok(true)
        }
        Err(e) => {
            if e.contains("400") || e.contains("404") {
                let _ = storage.mark_skipped(&pin.guid, &lock_token, &e);
            } else {
                let _ = storage.mark_failed(&pin.guid, &lock_token, &e);
            }
            Err(e)
        }
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/publisher.rs
git commit -m "feat: implement media publisher and Telegram zero-RAM forwarder"
```

---

### Task 8: Telegram Bot Command Router & Poller

**Files:**
- Create: `src/telegram.rs`

**Interfaces:**
- Produces: `run_telegram_poller(api, config, storage, tx_worker, running_flag)`.

- [ ] **Step 1: Implement `src/telegram.rs`**

```rust
use crate::config::Config;
use crate::publisher::publish_next_pin;
use crate::status::format_queue_finish_eta;
use crate::storage::Storage;
use chrono::Utc;
use frankenstein::{
    Api, GetUpdatesParams, Message, SendMessageParams, TelegramApi, UpdateContent,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::sync::Arc;
use std::thread::sleep;
use std::time::Duration;

#[derive(Debug)]
pub enum WorkerSignal {
    ForcePublish,
}

pub fn notify_admin(api: &Api, admin_id: i64, text: &str) {
    let params = SendMessageParams::builder()
        .chat_id(admin_id)
        .text(text)
        .disable_notification(true)
        .build();
    let _ = api.send_message(&params);
}

pub fn handle_message(
    api: &Api,
    config: &Config,
    storage: &Storage,
    tx_worker: &Sender<WorkerSignal>,
    message: &Message,
) {
    let text = match &message.text {
        Some(t) => t.trim(),
        None => return,
    };

    let chat_id = message.chat.id;
    let from_id = message.from.as_ref().map(|u| u.id as i64).unwrap_or(0);
    let is_admin = from_id == config.admin_id;

    let response = if text == "/start" {
        "Pinterest-to-Telegram Bot\n\nSend /help to view available commands".to_string()
    } else if text == "/help" {
        "Available commands:\n/status - Show system status\n/force_publish - Publish next pin (admin only)\n/clear - Clear storage (admin only)\n/reset_published - Reset publication status (admin only)".to_string()
    } else if text == "/status" {
        match storage.get_stats() {
            Ok(stats) => {
                let eta = format_queue_finish_eta(stats.pending, config.publish_poll_seconds as i64, Utc::now());
                format!(
                    "Statistics:\nTotal pins: {}\nPending: {}\nProcessing: {}\nPublished: {}\nFailed: {}\nSkipped: {}\nLast pending pin ETA: {}",
                    stats.total, stats.pending, stats.processing, stats.done, stats.failed, stats.skipped, eta
                )
            }
            Err(e) => format!("Error reading stats: {}", e),
        }
    } else if text == "/force_publish" {
        if !is_admin {
            "Access denied. Admin only command.".to_string()
        } else {
            let _ = tx_worker.send(WorkerSignal::ForcePublish);
            "Publish cycle triggered.".to_string()
        }
    } else if text == "/clear" {
        if !is_admin {
            "Access denied. Admin only command.".to_string()
        } else {
            match storage.clear_storage() {
                Ok(count) => format!("Storage cleared. Removed {} pins", count),
                Err(e) => format!("Error clearing storage: {}", e),
            }
        }
    } else if text == "/reset_published" {
        if !is_admin {
            "Access denied. Admin only command.".to_string()
        } else {
            match storage.reset_published() {
                Ok(count) => format!("Reset {} pins to pending.", count),
                Err(e) => format!("Error resetting pins: {}", e),
            }
        }
    } else {
        "Use /help to view available commands".to_string()
    };

    let params = SendMessageParams::builder()
        .chat_id(chat_id)
        .text(response)
        .build();
    let _ = api.send_message(&params);
}

pub fn run_telegram_poller(
    api: Arc<Api>,
    config: Arc<Config>,
    storage: Storage,
    tx_worker: Sender<WorkerSignal>,
    running: Arc<AtomicBool>,
) {
    println!("Starting Telegram long-polling thread...");
    notify_admin(&api, config.admin_id, "Bot has been restarted");

    let mut offset: Option<u64> = None;

    while running.load(Ordering::SeqCst) {
        let mut builder = GetUpdatesParams::builder().timeout(20u32);
        if let Some(off) = offset {
            builder = builder.offset(off);
        }
        let params = builder.build();

        match api.get_updates(&params) {
            Ok(response) => {
                for update in response.result {
                    offset = Some(update.update_id + 1);
                    if let UpdateContent::Message(ref msg) = update.content {
                        handle_message(&api, &config, &storage, &tx_worker, msg);
                    }
                }
            }
            Err(err) => {
                eprintln!("Error in get_updates: {:?}", err);
                sleep(Duration::from_secs(2));
            }
        }
    }

    println!("Telegram poller stopped cleanly.");
}
```

- [ ] **Step 2: Commit**

```bash
git add src/telegram.rs
git commit -m "feat: implement Telegram long-polling and command handler"
```

---

### Task 9: Main Orchestration & Background Scheduler

**Files:**
- Modify: `src/main.rs`

**Interfaces:**
- Consumes: `Config`, `Storage`, `run_telegram_poller`, `fetch_and_store_pins`, `publish_next_pin`.
- Spawns background worker thread and Telegram poller with 512KB stacks, handles `SIGINT`/`SIGTERM`.

- [ ] **Step 1: Implement `src/main.rs`**

```rust
mod config;
mod publisher;
mod rss;
mod scraper;
mod status;
mod storage;
mod telegram;
mod types;

use config::Config;
use frankenstein::Api;
use publisher::publish_next_pin;
use rss::fetch_and_store_pins;
use status::format_rss_parsed_message;
use storage::Storage;
use telegram::{notify_admin, run_telegram_poller, WorkerSignal};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::Arc;
use std::thread::{self, Builder};
use std::time::{Duration, Instant};

fn main() {
    println!("Pinterest-to-Telegram Rust Bot starting...");

    let config = match Config::from_env() {
        Ok(cfg) => Arc::new(cfg),
        Err(err) => {
            eprintln!("Configuration error: {}", err);
            std::process::exit(1);
        }
    };

    let storage = match Storage::open(Arc::clone(&config)) {
        Ok(st) => st,
        Err(err) => {
            eprintln!("Failed to open storage database: {}", err);
            std::process::exit(1);
        }
    };

    let api = Arc::new(Api::new(&config.telegram_bot_token));

    let (tx_worker, rx_worker) = channel::<WorkerSignal>();
    let running = Arc::new(AtomicBool::new(true));

    // Handle signals for graceful shutdown
    let r_sig = Arc::clone(&running);
    let tx_sig = tx_worker.clone();
    if let Err(e) = ctrlc::set_handler(move || {
        println!("\nShutdown signal received. Exiting gracefully...");
        r_sig.store(false, Ordering::SeqCst);
        let _ = tx_sig.send(WorkerSignal::ForcePublish); // Wake worker
    }) {
        eprintln!("Error setting Ctrl-C handler: {}", e);
    }

    // 1. Spawn Telegram Poller Thread (512 KB Stack)
    let api_poller = Arc::clone(&api);
    let config_poller = Arc::clone(&config);
    let storage_poller = storage.clone();
    let running_poller = Arc::clone(&running);

    let poller_handle = Builder::new()
        .name("telegram_poller".to_string())
        .stack_size(512 * 1024)
        .spawn(move || {
            run_telegram_poller(
                api_poller,
                config_poller,
                storage_poller,
                tx_worker,
                running_poller,
            );
        })
        .expect("Failed to spawn telegram poller thread");

    // 2. Spawn Background Scheduler Thread (512 KB Stack)
    let api_worker = Arc::clone(&api);
    let config_worker = Arc::clone(&config);
    let storage_worker = storage.clone();
    let running_worker = Arc::clone(&running);

    let worker_handle = Builder::new()
        .name("background_scheduler".to_string())
        .stack_size(512 * 1024)
        .spawn(move || {
            let mut last_rss = Instant::now() - Duration::from_secs(config_worker.rss_poll_seconds);
            let mut last_publish = Instant::now();

            let rss_interval = Duration::from_secs(config_worker.rss_poll_seconds);
            let pub_interval = Duration::from_secs(config_worker.publish_poll_seconds);

            while running_worker.load(Ordering::SeqCst) {
                let now = Instant::now();

                // Run RSS poller tick
                if now.duration_since(last_rss) >= rss_interval {
                    last_rss = Instant::now();
                    match fetch_and_store_pins(&config_worker, &storage_worker) {
                        Ok(saved) => {
                            if saved > 0 {
                                if let Ok(stats) = storage_worker.get_stats() {
                                    let msg = format_rss_parsed_message(
                                        saved,
                                        stats.pending,
                                        config_worker.publish_poll_seconds as i64,
                                    );
                                    notify_admin(&api_worker, config_worker.admin_id, &msg);
                                }
                            }
                        }
                        Err(e) => eprintln!("RSS worker error: {}", e),
                    }
                }

                // Run publish worker tick
                if now.duration_since(last_publish) >= pub_interval {
                    last_publish = Instant::now();
                    let _ = publish_next_pin(&api_worker, &config_worker, &storage_worker);
                }

                // Sleep up to 1 second or respond to instant signal
                match rx_worker.recv_timeout(Duration::from_secs(1)) {
                    Ok(WorkerSignal::ForcePublish) => {
                        if running_worker.load(Ordering::SeqCst) {
                            println!("Immediate publish triggered via /force_publish");
                            let _ = publish_next_pin(&api_worker, &config_worker, &storage_worker);
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }

            println!("Background worker stopped cleanly.");
        })
        .expect("Failed to spawn worker scheduler thread");

    let _ = poller_handle.join();
    let _ = worker_handle.join();
    println!("Bot shutdown complete.");
}
```

- [ ] **Step 2: Commit**

```bash
git add src/main.rs
git commit -m "feat: complete main orchestration and dual-threaded scheduler"
```

---

### Task 10: Dockerfile & Multi-Stage Deployment Setup

**Files:**
- Modify: `Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `.dockerignore`

**Interfaces:**
- Produces: Production Docker container setup creating an ultra-lightweight Alpine container.

- [ ] **Step 1: Update `Dockerfile` to multi-stage Rust build**

```dockerfile
FROM rust:alpine AS builder
RUN apk add --no-cache musl-dev pkgconfig openssl-dev sqlite-dev
WORKDIR /app
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

FROM alpine:latest
RUN apk add --no-cache ca-certificates libgcc
WORKDIR /app
COPY --from=builder /app/target/release/pinterest-to-telegram-bot /usr/local/bin/bot
VOLUME ["/app/data"]
CMD ["bot"]
```

- [ ] **Step 2: Update `docker-compose.yml`**

```yaml
services:
  bot:
    build: .
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      - ./data:/app/data
```

- [ ] **Step 3: Update `.dockerignore`**

```
target/
data/
.git/
.env
*.sqlite*
node_modules/
```

- [ ] **Step 4: Commit**

```bash
git add Dockerfile docker-compose.yml .dockerignore
git commit -m "chore: setup multi-stage Rust Docker build and compose volume mount"
```

---

### Task 11: Cleanup Legacy TypeScript & Documentation

**Files:**
- Remove / Archive: `package.json`, `bun.lock`, `tsconfig.json`, `src/*.ts`
- Modify: `README.md`

- [ ] **Step 1: Clean up TypeScript source files from `src/`**

Remove `.ts` files from `src/` now that full Rust implementation is in place.

- [ ] **Step 2: Update `README.md` to reflect the Rust Frankenstein implementation**

Document the new Rust architecture, RAM efficiency (~3–5 MB), and deployment steps.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: update README for ultra-low RAM Rust frankenstein bot"
```
