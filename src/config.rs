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
