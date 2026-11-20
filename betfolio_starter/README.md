# Betfolio Worker patch — Supabase API key compatibility

This patch updates `worker/src/index.js` so the Telegram Worker supports both:

- New Supabase Secret API keys beginning with `sb_secret_`: sent in the `apikey` header only.
- Legacy Supabase `service_role` JWT keys: sent in both `apikey` and `Authorization: Bearer` headers.

## Apply the patch

1. In your existing extracted Betfolio project, replace `worker/src/index.js` with the supplied `index.js`.
2. Open CMD in the `worker` folder (the same folder that contains `wrangler.toml`).
3. Run `npx wrangler deploy`.
4. Add the Supabase backend key as a Worker secret:

   `npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY`

   Prefer the `sb_secret_...` key from Supabase Settings → API Keys. Do not use the publishable/anon key here. A legacy `service_role` key is also supported while Supabase still provides it.

5. Add the webhook secret:

   `npx wrangler secret put TELEGRAM_WEBHOOK_SECRET`

   Use a strong random value containing only letters, numbers, `_` and `-`, and keep it safe. The same value must be provided when registering the Telegram webhook.

## Before testing `/whoami`

- Run the complete `supabase/schema.sql` in the Supabase SQL Editor first.
- Ensure the configured `SUPABASE_USER_ID` equals the UUID of your own Supabase Auth user.
- Ensure `SUPABASE_URL` is the correct project URL.
- Register the Telegram webhook at `https://<worker-hostname>/webhook` with the same `TELEGRAM_WEBHOOK_SECRET`.
- Send `/whoami` in a private chat with your bot. Then set the returned numeric ID using `npx wrangler secret put ALLOWED_TELEGRAM_USER_ID`.

`APP_URL` in `worker/wrangler.toml` should be the actual Cloudflare Pages website URL (normally `https://<project>.pages.dev`), not the Worker URL. This only controls the Dashboard link shown by `/help`.

Never put the Supabase secret key, Telegram bot token, or webhook secret in the website's `site/config.js` or share them in chat.
