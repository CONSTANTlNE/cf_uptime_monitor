# Uptime Monitor

A minimal, self-hosted uptime monitor built as a single Cloudflare Worker. No external dependencies beyond Cloudflare APIs.

## Stack

- **Cloudflare Worker** — vanilla JavaScript, no bundler
- **Cloudflare KV** — stores monitor config, status, and history
- **Cloudflare Cron Trigger** — scheduled checks every minute
- **Telegram Bot API** — up/down alerts

---

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ and npm
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is sufficient)
- Wrangler CLI — installed as a dev dependency, no global install needed

---

## Deployment

### 1. Install Wrangler

```bash
npm install
```

This installs Wrangler locally into `node_modules/`. All commands below use `npx wrangler` so no global install is needed. Alternatively, install Wrangler globally once:

```bash
npm install -g wrangler
```

Then replace every `npx wrangler` below with just `wrangler`.

---

### 2. Authenticate Wrangler with Cloudflare

```bash
npx wrangler login
```

A browser window opens. Log in to your Cloudflare account and authorize Wrangler. Your credentials are stored in `~/.wrangler/config/` — you only need to do this once per machine.

To confirm it worked:

```bash
npx wrangler whoami
```

---

### 3. Create a KV namespace

The app uses Cloudflare KV to store monitor config, status history, and settings.

```bash
npx wrangler kv:namespace create "KV"
```

The output looks like:

```
Add the following to your configuration file in your kv_namespaces array:
{ binding = "KV", id = "abc123def456..." }
```

Copy that `id` value and paste it into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "KV"
id = "abc123def456..."   # ← replace this
```

> **Preview namespace (optional):** If you want a separate KV namespace for `wrangler dev` (local development), run:
> ```bash
> npx wrangler kv:namespace create "KV" --preview
> ```
> Then add the returned `preview_id` to `wrangler.toml`:
> ```toml
> [[kv_namespaces]]
> binding = "KV"
> id = "abc123def456..."
> preview_id = "xyz789..."
> ```

---

### 4. Set secrets

Secrets are stored encrypted in Cloudflare's vault — they are **never** written to any file. You will be prompted to type (or paste) each value.

**Admin password** — used to log in to the dashboard:

```bash
npx wrangler secret put ADMIN_PASSWORD
```

**Session signing key** — used to HMAC-sign the session cookie. Must be a long, random string:

```bash
npx wrangler secret put SECRET_KEY
```

Generate a suitable value with:

```bash
openssl rand -hex 32
```

> Both secrets can also be set in the [Cloudflare dashboard](https://dash.cloudflare.com/) under **Workers & Pages → your worker → Settings → Variables and Secrets**.

---

### 5. Deploy

```bash
npx wrangler deploy
```

This bundles `src/index.js` and uploads it to Cloudflare along with the cron trigger defined in `wrangler.toml`. On success you'll see:

```
Deployed uptime-monitor triggers (1 route, 1 cron)
  https://uptime-monitor.<your-subdomain>.workers.dev
```

Open that URL — you should see the login page.

---

### 6. Configure Telegram alerts (optional)

Alerts are configured through the app's own Settings page, not via any config file.

**Create a Telegram bot:**

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the bot token BotFather gives you (format: `1234567890:AABBccDDeeFFggHH...`)

**Get your chat ID:**

- For a personal chat: start a conversation with your bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` after sending it any message — the `chat.id` field in the JSON is your ID
- For a group: add the bot to the group, send a message, and use the same `getUpdates` URL — group IDs are negative numbers (e.g. `-1001234567890`)

**Configure in the dashboard:**

1. Open your Worker URL and log in
2. Click **Settings** in the header
3. Paste the bot token into the **Bot Token** field
4. Paste one or more chat IDs into the **Chat IDs** field (one per line)
5. Click **Save**
6. Click **Send Test Alert** — you should receive a Telegram message within a few seconds

---

## Local development

Start a local dev server with:

```bash
npx wrangler dev
```

Wrangler runs the Worker locally at `http://localhost:8787`. KV reads and writes go to your real Cloudflare KV namespace (or the preview namespace if you configured one).

**Testing the cron handler locally:**

Cron triggers do not fire automatically in dev mode. Trigger a manual check with:

```bash
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

---

## Updating

To deploy a new version after making changes:

```bash
npx wrangler deploy
```

Secrets and KV data persist across deploys — only the Worker code is updated.

To update a secret:

```bash
npx wrangler secret put ADMIN_PASSWORD
# type the new value at the prompt
```

---

## Teardown

To delete the Worker and all associated resources:

```bash
# Delete the Worker
npx wrangler delete

# Delete the KV namespace (use the id from wrangler.toml)
npx wrangler kv:namespace delete --namespace-id "96b90660c75c4ecb992fc4aa0b830365"
```

> This is irreversible. All stored monitors, history, and settings will be lost.

---

## Features

- **Dashboard** — live status table with sparklines, uptime %, response time, last-checked timestamp; auto-refreshes every 30 s
- **Add monitors** — name, URL, check interval (30 s up to 1 h)
- **Pause / resume** — toggle individual monitors without deleting them
- **Alerts** — Telegram messages on state change (up → down and down → up), including downtime duration on recovery
- **Auth** — single admin password, HMAC-SHA256 signed session cookie with 7-day expiry; `httpOnly`, `Secure`, `SameSite=Strict`

---

## Cron interval note

Cloudflare Cron Triggers have a **minimum granularity of 1 minute**. The `~30s` interval option in the UI stores 30 s as the target, but the actual check fires on the next cron tick (~60 s). All other intervals (1 m, 2 m, 5 m…) work as expected. For true sub-minute polling, Durable Object Alarms would be needed — out of scope for this version.

---

## KV schema

| Key | Value |
|-----|-------|
| `monitors:list` | `string[]` — ordered array of monitor IDs |
| `monitor:{id}` | `{ id, name, url, interval, enabled, createdAt }` |
| `status:{id}` | `{ status, since, lastCheck, lastResponseTime }` |
| `history:{id}` | Array of last 24 `{ t, ms, status }` entries |
| `config:telegram` | `{ botToken, chatIds[] }` |
