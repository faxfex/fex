# Betfolio — Personal Ledger, Risk Dashboard & Telegram Bot

Betfolio is a personal record-keeping app for lottery, betting and trading history. It calculates closed-record net P/L as `payout - stake - fee`; pending records are not counted as realized P/L. It is a tracker, not a recommendation, prediction or betting execution system.

## What's included

- Modern dashboard, 7-day performance chart, monthly category mix, searchable history and CSV/JSON export
- Manual bill entry and browser OCR (Thai + English) using Tesseract.js
- Daily/monthly budget, TP and SL monitoring
- Optional Supabase Auth + Postgres sync across devices
- Private storage for bill images
- Telegram bot commands: `/today`, `/summary`, `/month YYYY-MM`, `/budget`, `/add`
- Telegram photo inbox: saves the photo to private Supabase Storage, optionally runs Thai OCR, returns extracted text to Telegram, and makes the photo available in the web inbox for review
- Cloudflare Worker scheduled checks for daily/monthly TP, SL and budget alerts (one alert per threshold and period)

## Before you start

The frontend works locally without accounts. Cloud sync and Telegram need your own free-tier accounts and configuration. This ZIP is a deployable project scaffold; it is not already hosted, and it cannot connect to your accounts until you add the project keys and secrets described below.

### 1) Create Supabase project and database

1. Create a Supabase project at <https://supabase.com>.
2. Open **SQL Editor** and run the complete file `supabase/schema.sql`.
3. Open **Project Settings → API** (or API Keys) and copy the **Project URL** and the public **anon/publishable key**.
4. In Supabase **Authentication → URL Configuration**, add your deployed Cloudflare Pages URL to the allowed redirect URLs.
5. Create your personal user using the Betfolio signup form after deploying, then copy that user's UUID from **Authentication → Users**. This value becomes `SUPABASE_USER_ID` for the Worker.

The schema enables Row Level Security. Signed-in users can read and modify only rows whose `user_id` equals their own auth user ID. The Telegram Worker uses the Supabase service-role key server-side and is restricted to one Telegram user ID. Never put the service-role key in browser files.

### 2) Configure the web app

Edit `config.js` in the project root:

```js
window.BETFOLIO_CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT_REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_PUBLIC_ANON_OR_PUBLISHABLE_KEY",
  TELEGRAM_BOT_USERNAME: "YOUR_BOT_USERNAME"
};
```

Only the public URL and anon/publishable key belong here. Do not put a `service_role` key, Telegram token, webhook secret or OCR key in `config.js`.

### 3) Publish the website on Cloudflare Pages

1. Create a Cloudflare account at <https://dash.cloudflare.com>.
2. Create a Pages project and connect a Git repository containing this folder, or use Pages Direct Upload with the project root folder.
3. For this static project, use no build command and use the project root (`/`) as the output directory.
4. Open the generated `*.pages.dev` URL. The Cloud Sync button should show Supabase is ready. Sign up with your email and password, then sign in.
5. Test adding a record and refresh the page. Once signed in, the app syncs records/settings to Supabase and saves attached photos in the private `bill-images` bucket.

The app can also be opened locally by opening `index.html`, but cloud authentication should be tested from the HTTPS Pages URL rather than `file://`.

### 4) Deploy the Telegram Worker

Install Node.js and Wrangler, then open a terminal:

```bash
cd worker
npm install --global wrangler
npx wrangler login
```

Edit `worker/wrangler.toml` and replace:

- `SUPABASE_URL` with your Supabase Project URL
- `SUPABASE_USER_ID` with your Auth user UUID
- `APP_URL` with the deployed Cloudflare Pages URL

Deploy the Worker:

```bash
npx wrangler deploy
```

Add the required private secrets. Wrangler prompts for each value:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

Optional OCR key (see section 6):

```bash
npx wrangler secret put OCR_SPACE_API_KEY
```

Deploy once after adding/changing secrets:

```bash
npx wrangler deploy
```

### 5) Create Telegram bot and lock it to your account

1. In Telegram, open **@BotFather**, send `/newbot`, and copy the bot token.
2. Set it as `TELEGRAM_BOT_TOKEN` using the Wrangler command above.
3. Deploy with `ALLOWED_TELEGRAM_USER_ID` not set yet. Open your new bot and send `/whoami`.
4. Copy the numeric Telegram User ID returned by the bot and save it as a Worker secret:

```bash
npx wrangler secret put ALLOWED_TELEGRAM_USER_ID
```

5. Set a long random URL-safe webhook secret (letters, numbers, `_` or `-`) as `TELEGRAM_WEBHOOK_SECRET`. Use the exact same value when registering the webhook.
6. Register the webhook, replacing the URL and secret with your own values:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://<YOUR_WORKER_SUBDOMAIN>.workers.dev/webhook","secret_token":"<YOUR_WEBHOOK_SECRET>"}'
```

The Worker accepts private chats only and checks the sender's Telegram User ID against `ALLOWED_TELEGRAM_USER_ID`. Other Telegram users cannot query or add records. Keep the Worker and webhook secrets private.

### 6) OCR for Telegram photos (optional)

The website's browser OCR works without an OCR API key. For Telegram photos, the Worker can call OCR.space if `OCR_SPACE_API_KEY` is configured. Register for an API key at <https://ocr.space/ocrapi/freekey>, then save it using Wrangler. The Worker uses OCR Engine 2 with Thai as the language. OCR.space currently documents a free API quota of 500 requests per day per IP address; free service has no uptime guarantee. OCR results are returned as text and are **not saved as a financial record automatically**. Check the image and amounts, then send `/add` after confirming the values.

When enabled, Telegram bill images are sent from the Worker to OCR.space for text extraction. Do not use this path for images containing credentials, bank account secrets, passwords or other sensitive information.

### 7) Telegram commands

Send `/help` to the bot for the current command syntax.

| Command | What it does |
|---|---|
| `/today` | Summary for today's date in Bangkok time |
| `/summary` | Summary for the current month |
| `/month 2026-11` | Summary for a specific month |
| `/budget` | Daily/monthly budget, TP and SL values |
| `/add ...` | Add a record using the pipe-separated format below |
| Send a photo | Store photo in private storage and return OCR text if configured |

`/add` format (use `|` between fields):

```text
/add YYYY-MM-DD|lottery|record name|stake|payout|fee|status|note
```

Example:

```text
/add 2026-11-20|betting|Match tracking|100|0|0|lost|personal note
```

Accepted type values: `lottery` / `หวย`, `betting` / `เดิมพัน`, `trade` / `trading` / `เทรด`.

Accepted status values: `pending`, `won`, `lost`. For a lost record, payout is set to zero. For a pending record, P/L is not recognized yet.

### 8) TP/SL and budget notifications

The Worker Cron Trigger runs every 15 minutes. When a daily/monthly TP, SL or budget threshold is reached, it sends one alert per period and threshold to the allowed Telegram account. The daily/monthly calculations use Bangkok calendar dates. Update targets in the web app under **ความเสี่ยง & งบประมาณ**; the settings sync to Supabase when signed in.

## Important limitations and privacy

- Supabase Free currently includes 500 MB database storage and 1 GB file storage, and free projects can pause after a week of low activity. It does not include automatic backups. Export JSON/CSV regularly and keep an independent copy of bill images if they matter.
- The browser OCR can misread Thai numerals, labels and totals. Always verify suggestions before saving.
- Telegram OCR is a text extraction aid, not a receipt parser with guaranteed accuracy. The bot intentionally asks you to confirm values before using `/add`.
- Telegram bill uploads are stored in the private Supabase `bill-images` bucket under your user ID and listed in the web app's **กล่อง Telegram** page. The OCR inbox table is not public.
- The free OCR.space service is an external processor when configured. Review its privacy terms before sending bill images.
- Browser notifications run only while the web app is open. Telegram threshold alerts run through the Worker Cron Trigger.
- The starter tracks historical results and risk limits. It does not recommend picks, betting sizes, strategies, or trading signals, and it does not connect to betting or exchange execution APIs.

## Local-only mode

Open `index.html` in Chrome or Edge. Manual entry, browser OCR, dashboard, risk targets and local exports remain available without Supabase or Telegram configuration. Data is stored in that browser profile only.

## Official references

- Supabase pricing and Free plan: <https://supabase.com/pricing>
- Supabase free project pausing: <https://supabase.com/docs/guides/platform/free-project-pausing>
- Cloudflare Workers limits: <https://developers.cloudflare.com/workers/platform/limits/>
- Telegram Bot API: <https://core.telegram.org/bots/api>
- OCR.space API: <https://ocr.space/ocrapi>
