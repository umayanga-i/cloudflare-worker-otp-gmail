# OTP Worker — Deployment & Usage Guide

A Cloudflare Worker that sends 6-digit OTPs via the Gmail API and verifies them.  
Built with Cloudflare KV for storage, cryptographic OTP generation, and rate-limiting baked in.

---

## Architecture Overview

```
Client App
    │
    ├── POST /send-otp   ──►  Worker generates OTP
    │                          ├── Checks rate-limit KV key  (rl:<email>)
    │                          ├── Stores OTP in KV          (otp:<email>)
    │                          └── Sends branded HTML email via Gmail API
    │
    └── POST /verify-otp ──►  Worker reads KV
                               ├── Checks expiry
                               ├── Constant-time string compare
                               └── Deletes OTP on success (one-use)
```

---

## Prerequisites

- A **Cloudflare account** (free tier works)
- A **Google Cloud project** with Gmail API enabled
- OAuth2 credentials (Client ID + Secret + Refresh Token)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed

---

## Step 1 — Get Gmail OAuth2 Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Credentials**
2. Create an **OAuth 2.0 Client ID** (type: Web Application)
3. Add `https://developers.google.com/oauthplayground` as an Authorized Redirect URI
4. Go to [OAuth Playground](https://developers.google.com/oauthplayground/)
   - Click ⚙️ (settings) → enable **Use your own OAuth credentials** → paste your Client ID & Secret
   - In Step 1, select `https://mail.googleapis.com/auth/gmail.send` and authorize
   - In Step 2, click **Exchange authorization code for tokens**
   - Copy the **Refresh Token** — you only get this once

---

## Step 2 — Set Up the Project

```bash
# Create a new Worker project
npm create cloudflare@latest otp-worker
cd otp-worker

# Copy worker.js into src/index.js (or replace the generated file)
cp /path/to/worker.js src/index.js
```

Your `wrangler.toml` should look like:

```toml
name            = "otp-worker"
main            = "src/index.js"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding  = "OTP_STORE"
id       = "PASTE_YOUR_KV_NAMESPACE_ID_HERE"
```

---

## Step 3 — Create a KV Namespace

```bash
# Create the namespace
wrangler kv namespace create OTP_STORE

# Copy the id from the output and paste it into wrangler.toml
```

---

## Step 4 — Store Secrets

**Never commit credentials to version control.** Use Wrangler secrets:

```bash
wrangler secret put CLIENT_ID
wrangler secret put CLIENT_SECRET
wrangler secret put REFRESH_TOKEN
```

Then update `worker.js` to read from `env` instead of hardcoded constants:

```js
// In handleSendEmail / refreshAccessToken, replace:
const CLIENT_ID     = "YOUR_CLIENT_ID...";
const CLIENT_SECRET = "YOUR_CLIENT_SECRET";
const REFRESH_TOKEN = "YOUR_REFRESH_TOKEN";

// With (pass env down from fetch handler):
const CLIENT_ID     = env.CLIENT_ID;
const CLIENT_SECRET = env.CLIENT_SECRET;
const REFRESH_TOKEN = env.REFRESH_TOKEN;
```

---

## Step 5 — Customize & Deploy

Edit these constants at the top of `worker.js`:

| Constant        | Default        | Purpose                                    |
|-----------------|----------------|--------------------------------------------|
| `APP_NAME`      | `"MyApp"`      | Shown in email subject and header          |
| `SENDER_OPTIONS`| 3 example emails | Allowed sender addresses                 |
| `OTP_TTL_MS`    | `10 * 60 * 1000` | How long an OTP stays valid (ms)        |
| `RL_TTL_SEC`    | `5 * 60`       | Rate-limit window per email (seconds)      |

Deploy:

```bash
wrangler deploy
```

---

## API Reference

### `POST /send-otp`

Request an OTP for an email address.

**Request body:**
```json
{
  "to": "user@example.com",
  "sender": "you@gmail.com"
}
```

**Responses:**

| HTTP | Body | Meaning |
|------|------|---------|
| 200 | `{ "success": true, "message": "OTP sent..." }` | Email sent OK |
| 400 | `{ "success": false, "error": "Invalid email address." }` | Bad input |
| 400 | `{ "success": false, "error": "Sender address not allowed." }` | Sender not in whitelist |
| 429 | `{ "success": false, "error": "An OTP was already sent..." }` | Rate limited |
| 500 | `{ "success": false, "error": "..." }` | Gmail API / token error |

---

### `POST /verify-otp`

Validate the OTP a user entered.

**Request body:**
```json
{
  "email": "user@example.com",
  "otp": "482917"
}
```

**Responses:**

| HTTP | Body | Meaning |
|------|------|---------|
| 200 | `{ "success": true, "verified": true, "message": "OTP verified successfully." }` | ✅ Correct |
| 200 | `{ "success": true, "verified": false, "message": "Incorrect OTP..." }` | ❌ Wrong code |
| 400 | `{ "success": false, "error": "email and otp are required." }` | Missing fields |
| 404 | `{ "success": false, "verified": false, "error": "No OTP found..." }` | Not sent / expired |
| 410 | `{ "success": false, "verified": false, "error": "OTP has expired." }` | Timed out |
| 500 | `{ "success": false, "error": "..." }` | Server error |

---

## Testing with `test-client.html`

1. Deploy the worker and copy your Worker URL (e.g. `https://otp-worker.yourname.workers.dev`)
2. Open `test-client.html` in any browser (double-click — no server needed)
3. Paste your Worker URL into the **Worker Base URL** field at the top
4. Click **Ping** — you should see `HTTP 200 — Worker reachable ✅` in the log
5. Enter a recipient email, choose a sender, click **Send Verification Code**
6. Check the inbox, copy the 6-digit code
7. Paste into the **Verify OTP** card and click **Verify Code**

---

## Security Features

| Feature | Implementation |
|---------|---------------|
| **Rate limiting** | KV sentinel key with 5-minute TTL; returns HTTP 429 if hit |
| **OTP expiry** | 10-minute TTL stored in the record; server-side check before compare |
| **One-use codes** | OTP KV record deleted immediately after first successful verification |
| **Cryptographic OTP** | `crypto.getRandomValues()` — not `Math.random()` |
| **Constant-time compare** | XOR-based comparison prevents timing oracle attacks |
| **Sender whitelist** | Only addresses in `SENDER_OPTIONS` are accepted — no open relay |
| **Input validation** | Email regex + sender whitelist checked before any KV or API call |
| **CORS headers** | Present on all responses; tighten `Access-Control-Allow-Origin` in production |

---

## Production Checklist

- [ ] Move `CLIENT_ID`, `CLIENT_SECRET`, `REFRESH_TOKEN` to Wrangler secrets
- [ ] Set `Access-Control-Allow-Origin` to your exact frontend domain (not `*`)
- [ ] Restrict `SENDER_OPTIONS` to only the addresses you own
- [ ] Set up a [Cloudflare WAF](https://developers.cloudflare.com/waf/) rule to block abusive IPs
- [ ] Add a Gmail sending quota alert in Google Cloud Console
- [ ] Consider [Cloudflare Zero Trust](https://developers.cloudflare.com/cloudflare-one/) for admin routes
- [ ] Monitor KV usage in the Cloudflare dashboard (free tier: 100k reads/day)

---

## KV Storage Layout

```
Key              Value                          TTL
──────────────── ────────────────────────────── ─────────
otp:<email>      { "otp": "482917",             10 min
                   "expiresAt": 1718000000000 }

rl:<email>       "1"                            5 min
```

Both keys are scoped to the email address and expire automatically — no cleanup needed.

---

## Common Errors

| Error | Likely Cause | Fix |
|-------|-------------|-----|
| `Failed to refresh Gmail access token` | Refresh token expired or revoked | Re-run OAuth Playground, get a new refresh token |
| `Gmail API error: 403` | Gmail API not enabled | Enable it in Google Cloud Console → APIs & Services |
| `Gmail API error: 400` | Invalid sender address | The "From" must be an address authorized by the OAuth account |
| `Network error` in test client | CORS blocked or wrong Worker URL | Check URL has no trailing slash; check `Access-Control-Allow-Origin` |
| KV read returns null | OTP expired before verification | User needs to request a new code |
