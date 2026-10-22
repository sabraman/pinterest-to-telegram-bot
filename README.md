# Pinterest to Telegram Bot (Frankenstein Rust Edition)

A high-performance, ultra-low RAM Rust bot that reads a Pinterest RSS feed and publishes queued pins to a Telegram channel using the [`frankenstein`](https://crates.io/crates/frankenstein) crate.

## Runtime & Performance

- **Language:** Rust (2021 edition)
- **Telegram Client:** `frankenstein` (synchronous `client-ureq`)
- **Memory Footprint:** **~3–5 MB RSS** (vs ~60–80 MB for Bun/Node)
- **Concurrency:** Dual-threaded synchronous architecture with capped 512 KB thread stacks (no Tokio/async runtime overhead)
- **Storage:** SQLite durable queue in `data/bot.sqlite` (compatible with legacy database)
- **Media Support:** Photo, video, GIF/animation, and carousel (album) publishing
- **Deployment:** Multi-stage Docker Alpine build with `restart: unless-stopped`

## Queue Behavior

RSS entries are stored once by GUID. Publish jobs move through these states:

- `pending` - ready to publish
- `processing` - claimed by the publisher worker
- `done` - published to Telegram
- `failed` - waiting for retry or exhausted attempts
- `skipped` - permanently skipped because the media or Telegram request is invalid

The queue survives container restarts because SQLite is mounted from `./data`.

## Configuration

Create `.env`:

```env
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHANNEL_ID=-1001219339693
ADMIN_ID=126642711
PINTEREST_FEED=https://ru.pinterest.com/sabraman/1telegram.rss
DATABASE_PATH=data/bot.sqlite
RSS_POLL_SECONDS=180
PUBLISH_POLL_SECONDS=900
PUBLISH_RETRY_SECONDS=300
QUEUE_LOCK_SECONDS=120
MAX_PUBLISH_ATTEMPTS=5
FETCH_TIMEOUT_SECONDS=30
PUBLISH_SEND_DELAY_MS=1000
```

## Local Development (Cargo)

```bash
# Run unit tests
cargo test

# Run bot locally
cargo run
```

## Docker Deployment

```bash
docker compose up -d --build
docker compose logs -f bot
```

On a VPS, make sure Docker starts after reboot:

```bash
systemctl enable --now docker
docker compose up -d --build
```

The Compose file uses `restart: unless-stopped`, so the bot container automatically recovers when Docker starts after a server reboot.

## Bot Commands

- `/start` - Start working with the bot
- `/help` - Show available commands
- `/status` - Show queue statistics and queue completion ETA in Moscow Standard Time (MSK)
- `/force_publish` - Publish the next queued pin immediately (admin only)
- `/clear` - Clear SQLite storage (admin only)
- `/reset_published` - Reset all pins to pending (admin only)
