# Ventura — Deploy to Render in 10 minutes

## What you need
- GitHub account (you have this ✓)
- Render account (you have this ✓)  
- Anthropic API key → https://console.anthropic.com

---

## Step 1 — Push to GitHub (3 min)

1. Go to **github.com** → click **New repository**
2. Name it `ventura-platform`, set to **Public**, click **Create**
3. On your computer, extract the `ventura-platform.zip` you downloaded
4. Open a terminal in the extracted folder and run:

```bash
git init
git add .
git commit -m "Initial Ventura platform"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/ventura-platform.git
git push -u origin main
```

> **No terminal?** Use the GitHub web uploader: drag all files into the repo page.

---

## Step 2 — Deploy via Render Blueprint (5 min)

Render reads the `render.yaml` file in your repo and creates both services automatically.

1. Go to **render.com** → click **New +** → **Blueprint**
2. Connect your GitHub account if not already connected
3. Select the `ventura-platform` repository
4. Render detects `render.yaml` and shows you two services:
   - `ventura-api` (Node.js web service)
   - `ventura-frontend` (Static site)
5. Click **Apply**

### When it asks for secret environment variables:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your key from console.anthropic.com |
| `JWT_SECRET` | Click "Generate" — Render fills this in automatically |
| `FRONTEND_URL` | Leave blank for now (fill in after first deploy) |

Everything else has defaults. Click **Apply** again.

---

## Step 3 — Connect frontend → backend (2 min)

Once both services are deployed (green status):

1. Copy your **API service URL** — looks like `https://ventura-api.onrender.com`
2. Go to the **ventura-frontend** service → **Environment**
3. There's nothing to add here — instead, go to **ventura-api** → **Environment**
4. Add: `FRONTEND_URL` = `https://ventura-frontend.onrender.com`
   (your actual frontend URL from Render)
5. Click **Save Changes** — the API redeploys in ~30 seconds

Then open `ventura-frontend.onrender.com/ventura/config.js` and update it:

```
window.__VENTURA_API_URL__ = "https://ventura-api.onrender.com"
```

**Easiest way:** Edit `ventura/config.js` in GitHub directly:
1. Go to your repo → `ventura-backend/ventura/config.js`
2. Click the pencil icon (Edit)
3. Change the file to:

```javascript
window.VENTURA_CONFIG = {
  API_URL: "https://ventura-api.onrender.com",  // ← your actual API URL
  WS_URL: null
};
```

4. Commit → Render auto-redeploys the frontend in ~30 seconds

---

## Step 4 — Verify it's working

Open your frontend URL. You should see the Ventura landing page.

- Click **Dashboard** → you're in demo mode with seeded data
- Click **Launch a business** → fill in the wizard → your first business is provisioned
- The agent runs its first cycle at **2am** (the cron schedule)
- To trigger it immediately: Dashboard → click **Run agent now**

Check the API is healthy:
```
https://ventura-api.onrender.com/api/health
```
Should return: `{"status":"ok","timestamp":"..."}`

---

## ⚠️ Important: Render free tier spin-down

The free tier spins down after **15 minutes of inactivity**. This means:
- The nightly **2am cron** will be missed if no one hits the site that day
- First request after spin-down takes ~30 seconds (cold start)

**Fix:** Upgrade to Render's **Starter plan ($7/mo)** for the API service only. This keeps it always-on. The frontend static site stays free forever.

Alternative free fix: use **UptimeRobot** (free) to ping `/api/health` every 10 minutes, which keeps the service warm.

---

## Adding optional integrations later

| Feature | What to add |
|---|---|
| Email sending | Add `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` (use Resend.com — free 3k emails/mo) |
| Stripe payments | Add `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` |
| Web search for agent | Add `BRAVE_SEARCH_API_KEY` (free 2k searches/mo) |
| Auto website deploy | Add `VERCEL_TOKEN` |
| Social posting | Add `TWITTER_BEARER_TOKEN`, `LINKEDIN_ACCESS_TOKEN` |

All added in Render → ventura-api → Environment → Add Environment Variable.

---

## Custom domain (optional)

1. Render → ventura-frontend → Settings → Custom Domains → Add
2. Enter your domain (e.g. `ventura.yourdomain.com`)
3. Add the CNAME record Render shows you to your DNS provider
4. Update `FRONTEND_URL` in ventura-api to your custom domain
5. Update `ventura/config.js` with the custom API domain if you add one there too

---

## Troubleshooting

**Frontend shows but dashboard is blank / API errors**
→ Check `ventura/config.js` has the correct API URL
→ Check ventura-api logs in Render for errors

**"Missing ANTHROPIC_API_KEY" in logs**
→ Render → ventura-api → Environment → verify the key is set

**Agent not running at 2am**
→ Free tier spin-down issue — add UptimeRobot ping or upgrade to Starter
→ You can always trigger manually: Dashboard → Run agent now

**WebSocket disconnects**
→ Normal on Render free tier — the frontend auto-reconnects with backoff
→ Upgrade to Starter for persistent connections
