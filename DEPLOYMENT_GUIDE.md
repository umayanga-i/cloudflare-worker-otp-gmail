# 📧 Gmail OTP Worker — Complete Deployment Guide

A production-ready Cloudflare Worker for sending and verifying 6-digit OTP codes via Gmail API with built-in rate limiting and security features.

---

## 📋 Quick Start (5 minutes)

### 1️⃣ Prerequisites
- ✅ Cloudflare account (free tier OK)
- ✅ Google Cloud project with Gmail API enabled
- ✅ Node.js 16+ and npm installed
- ✅ Wrangler CLI (`npm install -g wrangler`)

### 2️⃣ Get Gmail OAuth2 Credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Credentials**
2. Create **OAuth 2.0 Client ID** (Web Application)
3. Add `https://developers.google.com/oauthplayground` as Authorized Redirect URI
4. Go to [OAuth Playground](https://developers.google.com/oauthplayground/)
   - Click ⚙️ → enable **Use your own OAuth credentials**
   - Select `https://mail.googleapis.com/auth/gmail.send`
   - Follow flow to get **Refresh Token**

### 3️⃣ Clone & Setup

```bash
cd Gmail-Worker-Bridge-Serverless-OAuth2-Email-Dispatcher
npm install
```

### 4️⃣ Create KV Namespace

```bash
wrangler kv namespace create OTP_STORE
# Copy the ID from output
```

Then update `wrangler.toml`:
```toml
[[kv_namespaces]]
binding  = "OTP_STORE"
id       = "PASTE_ID_HERE"  # ← Your KV namespace ID
```

### 5️⃣ Store Secrets (Production)

```bash
wrangler secret put CLIENT_ID
wrangler secret put CLIENT_SECRET
wrangler secret put REFRESH_TOKEN
```

Then update `src/index.js` to read from `env`:
```javascript
const CLIENT_ID     = env.CLIENT_ID;
const CLIENT_SECRET = env.CLIENT_SECRET;
const REFRESH_TOKEN = env.REFRESH_TOKEN;
```

### 6️⃣ Deploy

```bash
# Development (local testing)
npm run dev

# Deploy to production
npm run deploy

# Deploy to staging
npm run deploy:staging
```

---

## 🏗️ Project Structure

```
├── src/
│   └── index.js                    # Main Worker code
├── wrangler.toml                   # Cloudflare config
├── package.json                    # Dependencies
├── .env.example                    # Environment template
├── .gitignore                      # Git excludes
├── GUIDE.md                        # OTP Worker reference
├── DEPLOYMENT_GUIDE.md             # This file
└── README.md                       # Project overview
```

---

## 🔐 Security Checklist

- [ ] Move `CLIENT_ID`, `CLIENT_SECRET`, `REFRESH_TOKEN` to Wrangler secrets
- [ ] Set `Access-Control-Allow-Origin` to your frontend domain (not `*`)
- [ ] Restrict `SENDER_OPTIONS` to only your addresses
- [ ] Enable [Cloudflare WAF](https://developers.cloudflare.com/waf/) rules
- [ ] Monitor KV usage (free tier: 100k reads/day)
- [ ] Set Gmail quota alerts in Google Cloud Console
- [ ] Consider [Cloudflare Zero Trust](https://developers.cloudflare.com/cloudflare-one/) for admin routes

---

## 📡 API Reference

### Send OTP

**Endpoint:** `POST /send-otp`

**Request:**
```json
{
  "to": "user@example.com",
  "sender": "you@gmail.com"  // optional
}
```

**Response (200):**
```json
{
  "success": true,
  "message": "OTP sent to user@example.com. Valid for 10 minutes."
}
```

**Response (429 - Rate Limited):**
```json
{
  "success": false,
  "error": "An OTP was already sent to this address within the last 5 minutes..."
}
```

---

### Verify OTP

**Endpoint:** `POST /verify-otp`

**Request:**
```json
{
  "email": "user@example.com",
  "otp": "482917"
}
```

**Response (200 - Success):**
```json
{
  "success": true,
  "verified": true,
  "message": "OTP verified successfully."
}
```

**Response (200 - Wrong Code):**
```json
{
  "success": true,
  "verified": false,
  "message": "Incorrect OTP. Please try again."
}
```

---

## 🧪 Testing

### Local Testing

```bash
npm run dev
```

Visit `http://localhost:8787` in your browser. Built-in test UI provided.

### Remote Testing (After Deploy)

1. Copy your Worker URL (e.g., `https://otp-worker.yourname.workers.dev`)
2. Update the URL in the test UI
3. Click **Ping Worker**
4. Send OTP → Check your email → Copy code
5. Verify OTP

---

## 🚀 Advanced Configuration

### Custom Email Template

Edit the `formatEmailRFC2822()` function in `src/index.js`:

```javascript
function formatEmailRFC2822(sender, recipient, otp) {
  const htmlBody = `
    <html>
      <!-- Your custom HTML here -->
      <p>Your code: ${otp}</p>
    </html>
  `;
  // ...
}
```

### Change OTP Duration

In `src/index.js`:

```javascript
const OTP_TTL_MS  = 15 * 60 * 1000;  // 15 minutes
const OTP_TTL_SEC = 15 * 60;          // Must match
```

### Add Multiple Sender Domains

In `src/index.js`:

```javascript
const SENDER_OPTIONS = [
  { label: "Support", email: "support@yourdomain.com" },
  { label: "Noreply", email: "noreply@yourdomain.com" },
  { label: "Admin", email: "admin@yourdomain.com" },
];
```

### Environment-Specific Deployments

```bash
# Staging
npm run deploy:staging

# Production
npm run deploy:prod
```

Both environments use separate KV namespaces (configure in `wrangler.toml`).

---

## 🔍 Monitoring & Logging

### View Real-Time Logs

```bash
npm run logs
```

### KV Storage Layout

```
Key              Value                          TTL
otp:<email>      { "otp": "482917",             10 min
                   "expiresAt": 1718000000000 }
rl:<email>       "1"                            5 min
```

### Check KV Usage

In Cloudflare Dashboard → **Workers & Pages → KV** → Monitor operations count.

---

## ❌ Troubleshooting

| Problem | Solution |
|---------|----------|
| `Failed to refresh Gmail access token` | Refresh token expired — re-run OAuth Playground |
| `403 Gmail API error` | Enable Gmail API in Google Cloud Console |
| `400 Gmail API error` | "From" must be an authorized Gmail address |
| `CORS blocked` | Check `Access-Control-Allow-Origin` in production |
| `OTP expired` | User took too long — request new code |
| `KV read returns null` | OTP already verified or expired |

---

## 📚 Additional Resources

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Cloudflare KV Storage](https://developers.cloudflare.com/workers/runtime-apis/kv/)
- [Gmail API Documentation](https://developers.google.com/gmail/api/guides)
- [Wrangler CLI Reference](https://developers.cloudflare.com/workers/wrangler/commands/)
- [RFC 2822 Email Format](https://tools.ietf.org/html/rfc2822)

---

## 📄 License

MIT License — See LICENSE file for details.

---

## 🤝 Support

For issues, questions, or contributions, please refer to the project repository.

**Last Updated:** June 2026  
**Version:** 2.0.0
