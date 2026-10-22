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
