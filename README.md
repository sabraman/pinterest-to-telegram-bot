# Pinterest to Telegram Bot

A Bun + TypeScript bot that reads a Pinterest RSS feed and publishes queued pins to a Telegram channel.

## Runtime

- Bun
- grammY long polling, no Telegram webhook
- SQLite durable queue in `data/bot.sqlite`
- Docker Compose deployment with `restart: unless-stopped`

## Queue Behavior

RSS entries are stored once by GUID. Publish jobs move through these states:

- `pending` - ready to publish
- `processing` - claimed by the publisher worker
- `done` - published to Telegram
- `failed` - waiting for retry or exhausted attempts
- `skipped` - permanently skipped because the image or Telegram request is invalid

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
```

## Local Development

```bash
bun install
bun run typecheck
bun run start
```

## Docker

```bash
docker compose up -d --build
docker compose logs -f bot
```

On a VPS, make sure Docker starts after reboot:

```bash
systemctl enable --now docker
docker compose up -d --build
```

The Compose file uses `restart: unless-stopped`, so the bot container starts again when Docker starts after a server reboot.

## Bot Commands

- `/start` - Start working with the bot
- `/help` - Show available commands
- `/status` - Show queue status
- `/force_publish` - Publish the next queued pin, admin only
- `/clear` - Clear SQLite storage, admin only
- `/reset_published` - Reset all pins to pending, admin only
