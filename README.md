# Pinterest to Telegram Bot

A bot for automatic publishing of pins from Pinterest RSS feed to a Telegram channel. Built with Deno using KV storage.

## Features

- Automatic pin fetching from Pinterest RSS feed
- Image publishing to Telegram channel
- Publication history storage in Deno KV
- Commands for bot management

## Setup

1. Clone the repository:
```bash
git clone https://github.com/sabraman/pinterest-to-telegram.git
cd pinterest-to-telegram
```

2. Create `.env` file with the following variables:
```env
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHANNEL_ID=your_channel_id
ADMIN_ID=your_telegram_id
PINTEREST_FEED=pinterest_url.rss
```

3. Configure webhook for the bot (replace YOUR_BOT_TOKEN and YOUR_DOMAIN):
```bash
curl -X POST "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook?url=https://YOUR_DOMAIN/YOUR_BOT_TOKEN"
```

### Deployment on Deno Deploy

#### Preparation

1. Create a new project on [Deno Deploy](https://deno.com/deploy)
2. Configure environment variables in the project settings:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHANNEL_ID`
   - `ADMIN_ID`
3. Set your bot's webhook URL by opening this in your browser (replace the values in `<...>`):
```text
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<PROJECT_NAME>.deno.dev/<BOT_TOKEN>
```

#### Deployment Methods

##### GitHub Integration (Recommended)
1. Push your project to a GitHub repository
2. In your Deno Deploy project settings, set up GitHub Integration
3. Select `src/server.ts` as the entry point
4. Your bot will automatically deploy on every push to the repository

##### Using deployctl (Advanced)
1. Install [deployctl](https://github.com/denoland/deployctl)
2. Create a new [access token](https://dash.deno.com/account#access-tokens)
3. Deploy using the command:
```bash
deployctl deploy --project <PROJECT_NAME> --prod --token <ACCESS_TOKEN>
```

## Bot Commands

- `/start` - Start working with the bot
- `/help` - Show available commands
- `/status` - Show status (total pins, unpublished pins, next check time)
- `/force_publish` - Publish next pin
- `/clear` - Clear KV storage
- `/reset_published` - Reset publication status
