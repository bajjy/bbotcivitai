# bbotcivitai

Telegram bot that enhances photos using Civitai's Qwen-Image **img2img** (`createVariant`).
Long-polling, single Node process, designed for systemd on a Hetzner VPS.

## Architecture

```
Telegram user
   │  photo (+ optional caption)
   ▼
┌─────────────────────────────────┐
│  bot.mjs  (grammY long-poll)    │
│  ├─ downloads from Telegram     │
│  ├─ writes to ./temp/{id}.jpg   │
│  └─ asks photoHost to expose it │
└─────────────────────────────────┘
   │  http://VPS:8088/photos/{id}.jpg
   ▼
┌─────────────────────────────────┐
│  Civitai orchestrator           │
│  POST /v2/consumer/workflows    │
│  $type=imageGen, ecosystem=qwen │
│  engine=sdcpp, model=20b        │
│  operation=createVariant        │
└─────────────────────────────────┘
   │  result image URL
   ▼
bot downloads it → replies as photo → deletes temp file
```

`createVariant` keeps the same dimensions as the source and uses the
`strength` parameter (0.0 = identical, 1.0 = ignore source). The default in
`.env.example` is `0.35` which gives an "enhance/sharpen" feel without changing
the content of the photo.

## Files

- `bot.mjs` — entrypoint, grammY handlers
- `services/civitai.mjs` — orchestrator client (submit + poll)
- `services/photoHost.mjs` — Express server that exposes uploaded photos to Civitai
- `config/config.mjs` — env-var loading
- `utils/paths.mjs` — file paths, temp dir creation
- `Dockerfile` + `.dockerignore` — for Coolify (or any container host)
- `deploy/bbotcivitai.service` — systemd unit (alternative to Docker)
- `.env.example` — copy to `.env` and fill in

## Local quick test

```bash
cp .env.example .env
# fill in BOT_TOKEN (from @BotFather) and CIVITAI_API_KEY
# leave PUBLIC_HOST_URL pointing at your VPS for now — local-only testing won't
# work because Civitai needs to fetch your photo over the public internet.

npm install
npm run check    # syntax check
npm run dev      # uses .env directly (no dotenv require)
```

## Deploy on Coolify (recommended if your VPS already runs Coolify)

The repo includes a `Dockerfile`. Coolify will build and run it for you.

### 1. Get the code somewhere Coolify can fetch

Easiest paths:

- **Public GitHub repo** — push this folder, point Coolify at the URL.
- **Coolify's built-in Gitea** — create a repo, push to it, point the app at it.
- **Private repo via deploy key** — Coolify generates the key, you add it to your repo.

### 2. Create the application in Coolify

1. *New Resource → Application → Public/Private Repository* (or *Dockerfile* if uploading directly).
2. **Build Pack:** `Dockerfile`
3. **Branch:** `main` (or whichever branch you push)
4. **Ports exposed:** `8088`
5. **Domain:** let Coolify auto-assign a `*.sslip.io` URL (or wire your own subdomain). Coolify will terminate HTTPS via Traefik for you.

### 3. Set environment variables in Coolify's UI

In the app's **Environment Variables** tab, add:

| Key | Value |
| --- | --- |
| `BOT_TOKEN` | (your fresh @BotFather token — *paste here, not in chat*) |
| `CIVITAI_API_KEY` | your Civitai key |
| `PUBLIC_HOST_URL` | the Coolify-assigned domain, e.g. `https://bbotcivitai-xyz.178.104.235.77.sslip.io` |
| `PHOTO_HOST_PORT` | `8088` |
| `QWEN_STRENGTH` | `0.35` |
| `QWEN_DEFAULT_PROMPT` | `high quality, sharp focus, fine detail, photorealistic, enhanced, 4k` |
| `PHOTO_TTL_SECONDS` | `900` |
| `ALLOWED_USER_IDS` | *(leave blank, or your numeric Telegram ID for private use)* |

Mark `BOT_TOKEN` and `CIVITAI_API_KEY` as **secret** so they're masked in the Coolify UI.

### 4. Deploy

Hit **Deploy**. Coolify will:
- `docker build` from the Dockerfile (cached `npm ci`),
- start the container,
- route the assigned domain → port `8088`,
- run the `HEALTHCHECK` that pings `/healthz`.

### 5. Smoke test

```
curl https://YOUR_COOLIFY_DOMAIN/healthz   # should print "ok"
```

Then DM your bot a photo with a caption like *"sharper, photorealistic"*. Watch logs in Coolify's app → Logs tab. You should see `[bot] @yourbot ready` then a download / submit / poll sequence.

If it fails:
- **`Civitai blocked`** → moderation; try a different prompt.
- **Civitai 4xx** → expand the error in `services/civitai.mjs` (it already includes status + body in the thrown error).
- **`getMe` 401 Unauthorized** → wrong `BOT_TOKEN`.

---

## Deploy on Hetzner (bare systemd, no Coolify)

These steps assume Ubuntu 22.04/24.04 on a fresh Hetzner Cloud VPS.

### 1. Install Node 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

### 2. Create the runtime user and directory

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin bbot
sudo mkdir -p /opt/bbotcivitai
sudo chown bbot:bbot /opt/bbotcivitai
```

### 3. Push the code to the VPS

From your dev machine:

```bash
rsync -av --exclude node_modules --exclude .env --exclude temp \
  ./ root@YOUR_VPS:/opt/bbotcivitai/
```

Then on the VPS:

```bash
sudo chown -R bbot:bbot /opt/bbotcivitai
sudo -u bbot bash -c 'cd /opt/bbotcivitai && npm ci --omit=dev'
```

### 4. Configure `.env`

```bash
sudo -u bbot cp /opt/bbotcivitai/.env.example /opt/bbotcivitai/.env
sudo -u bbot nano /opt/bbotcivitai/.env
```

Fill in `BOT_TOKEN`, `CIVITAI_API_KEY`, and `PUBLIC_HOST_URL`. For the public URL
you have two options:

**(a) Direct IP + port (simplest)**

```
PUBLIC_HOST_URL=http://203.0.113.42:8088
PHOTO_HOST_PORT=8088
```

Open the port in Hetzner Cloud's firewall and on the VPS:

```bash
sudo ufw allow 8088/tcp
```

**(b) nginx + Let's Encrypt + a subdomain (cleaner)**

```
PUBLIC_HOST_URL=https://bot.example.com
PHOTO_HOST_PORT=8088
```

Point an `A` record at the VPS, then on the VPS:

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo tee /etc/nginx/sites-available/bbotcivitai >/dev/null <<'NGINX'
server {
    listen 80;
    server_name bot.example.com;
    location / {
        proxy_pass http://127.0.0.1:8088;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
    }
}
NGINX
sudo ln -s /etc/nginx/sites-available/bbotcivitai /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d bot.example.com
```

### 5. Install the systemd unit

```bash
sudo cp /opt/bbotcivitai/deploy/bbotcivitai.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bbotcivitai
sudo systemctl status bbotcivitai
sudo journalctl -u bbotcivitai -f
```

### 6. Smoke test

From any machine:

```bash
curl http://YOUR_VPS:8088/healthz   # should print "ok"
```

Then in Telegram, message your bot with a photo. Watch:

```bash
sudo journalctl -u bbotcivitai -f
```

You should see `[bot] @yourbot ready`, then a download / submit / poll sequence
when you send a photo.

## Tuning

| Env var | What it does |
| --- | --- |
| `QWEN_STRENGTH` | 0.0–1.0. **Lower = closer to original.** 0.25–0.45 for "enhance", 0.6–0.8 for re-imagine. |
| `QWEN_DEFAULT_PROMPT` | Prompt used when the user sends no caption. |
| `PHOTO_TTL_SECONDS` | How long uploaded photos stay accessible. Civitai usually fetches within seconds. |
| `ALLOWED_USER_IDS` | Comma-separated Telegram user IDs. Empty = public. |

## Troubleshooting

- **"Civitai blocked that request"** — moderation filter; try a different prompt/photo.
- **"Civitai response missing workflow id"** — the API contract may have shifted; print
  the body in `civitai.mjs` and check against `developer.civitai.com/orchestration`.
- **Result image never downloads** — Civitai signed URLs expire; the bot fetches them
  immediately so this shouldn't happen unless polling timed out.
- **"address already in use" on 8088** — change `PHOTO_HOST_PORT` (and `PUBLIC_HOST_URL`).
# bbotcivitai
