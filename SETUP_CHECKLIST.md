# 🚀 Complete Setup & Deployment Checklist

Your Gmail-Worker-Bridge project deployment structure is now complete. Follow this step-by-step guide to deploy.

## ✅ Phase 1: Pre-Deployment (5 minutes)

### 1.1 Verify Project Files
```bash
cd Gmail-Worker-Bridge-Serverless-OAuth2-Email-Dispatcher

# Check key files exist
ls -la src/index.js              # Main worker
ls -la wrangler.toml            # Config
ls -la package.json             # Dependencies
ls -la .env.example             # Env template
```

### 1.2 Install Dependencies
```bash
npm install
```

Expected output:
```
added XXX packages in Xs
```

---

## ✅ Phase 2: Google Cloud Setup (10 minutes)

### 2.1 Create OAuth Credentials
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create new project: "Gmail Worker"
3. Enable Gmail API:
   - **APIs & Services** → **Library**
   - Search "Gmail API"
   - Click **Enable**

### 2.2 Create OAuth 2.0 Credentials
1. **APIs & Services** → **Credentials**
2. Click **+ Create Credentials** → **OAuth 2.0 Client ID**
3. Application type: **Web Application**
4. Authorized Redirect URIs: `https://developers.google.com/oauthplayground`
5. Click **Create**
6. Copy your **Client ID** and **Client Secret**

### 2.3 Get Refresh Token
1. Go to [OAuth Playground](https://developers.google.com/oauthplayground)
2. Click ⚙️ (Settings) → **Use your own OAuth credentials**
3. Paste your Client ID & Secret
4. In **Step 1 - Select & authorize APIs:**
   - Search: `https://mail.googleapis.com/auth/gmail.send`
   - Click **Authorize APIs**
5. Allow access to your account
6. In **Step 2 - Exchange authorization code for tokens:**
   - Click **Exchange authorization code for tokens**
7. Copy the **Refresh Token** (long string)

---

## ✅ Phase 3: Cloudflare Setup (5 minutes)

### 3.1 Install Wrangler CLI
```bash
npm install -g wrangler
```

### 3.2 Authenticate with Cloudflare
```bash
wrangler login
```

This opens a browser to authorize Wrangler with your Cloudflare account.

### 3.3 Create KV Namespace
```bash
wrangler kv namespace create OTP_STORE
```

You'll see output like:
```
✓ Successfully created namespace with ID: abcd1234efgh5678
```

**Copy this ID** for next step.

### 3.4 Update wrangler.toml
Edit `wrangler.toml` and replace `YOUR_KV_NAMESPACE_ID_HERE` with your ID:

```toml
[[kv_namespaces]]
binding  = "OTP_STORE"
id       = "abcd1234efgh5678"  # ← Paste your ID here
```

---

## ✅ Phase 4: Configure Secrets (5 minutes)

### 4.1 Store Secrets with Wrangler
```bash
# Interactive method (recommended)
node scripts/setup-secrets.js

# Or manual method
wrangler secret put CLIENT_ID
wrangler secret put CLIENT_SECRET
wrangler secret put REFRESH_TOKEN
```

### 4.2 Update src/index.js to Use Secrets
Open `src/index.js` and change the top section from:
```javascript
const CLIENT_ID     = "YOUR_CLIENT_ID.apps.googleusercontent.com";
const CLIENT_SECRET = "YOUR_CLIENT_SECRET";
const REFRESH_TOKEN = "YOUR_REFRESH_TOKEN";
```

To:
```javascript
const CLIENT_ID     = env.CLIENT_ID;
const CLIENT_SECRET = env.CLIENT_SECRET;
const REFRESH_TOKEN = env.REFRESH_TOKEN;
```

And modify the `fetch` handler to accept `env`:
```javascript
export default {
  async fetch(request, env, ctx) {
    // ... rest of code
```

---

## ✅ Phase 5: Local Development (10 minutes)

### 5.1 Start Development Server
```bash
npm run dev
```

Expected output:
```
✓ Using wrangler 3.x.x
✓ Loaded env vars from .env
✓ Listening on http://localhost:8787
```

### 5.2 Test Locally
1. Open browser: `http://localhost:8787`
2. You should see the OTP Worker test UI
3. Click **Ping Worker** → Should show ✅ Connected
4. Enter test email: `test@example.com`
5. Click **Send Code**

Check if email was received (if configured with real Gmail):
- Check spam folder
- Check that SENDER_OPTIONS includes your email

### 5.3 Stop Development Server
```bash
# Press Ctrl+C in terminal
```

---

## ✅ Phase 6: Staging Deployment (5 minutes)

### 6.1 Deploy to Staging
```bash
npm run deploy:staging
```

You'll see:
```
✓ Uploaded worker 'gmail-otp-worker-staging'
✓ Deployed to https://gmail-otp-worker-staging.yourname.workers.dev
```

### 6.2 Test on Staging
1. Copy your staging Worker URL
2. Open it in browser
3. Test the OTP flow end-to-end
4. Check logs: `npm run logs`

---

## ✅ Phase 7: Production Deployment (5 minutes)

### 7.1 Pre-Production Checklist
- [ ] Tested on staging environment
- [ ] CORS origin restricted (not `*`)
- [ ] SENDER_OPTIONS limited to your emails
- [ ] Rate limiting configured
- [ ] Gmail API quota sufficient

### 7.2 Deploy to Production
```bash
npm run deploy:prod
```

Output:
```
✓ Uploaded worker 'gmail-otp-worker-prod'
✓ Deployed to https://gmail-otp-worker-prod.yourname.workers.dev
```

### 7.3 Production Testing
1. Visit production URL in browser
2. Send test OTP
3. Check email received
4. Verify OTP code
5. Monitor logs: `npm run logs`

---

## 📊 Monitoring & Management

### View Real-Time Logs
```bash
npm run logs
# or
wrangler tail
```

### Check KV Usage
```bash
wrangler kv namespace list
wrangler kv key list --namespace-id YOUR_ID
```

### Adjust OTP Duration
Edit `src/index.js`:
```javascript
const OTP_TTL_MS  = 15 * 60 * 1000;  // Change to 15 minutes
const OTP_TTL_SEC = 15 * 60;
```

Then redeploy:
```bash
npm run deploy
```

---

## 🔒 Security Hardening (Production)

### 1. Restrict CORS Origin
In `src/index.js`, change:
```javascript
// From:
"Access-Control-Allow-Origin": "*",

// To:
"Access-Control-Allow-Origin": "https://yourdomain.com",
```

### 2. Use Custom Domain
Update `wrangler.toml`:
```toml
[env.production]
routes = [
  { pattern = "otp.yourdomain.com/*", zone_id = "YOUR_ZONE_ID" }
]
```

### 3. Enable Cloudflare WAF
1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. **Security** → **WAF** → Create rules
3. Block IP ranges that abuse your API

### 4. Set Up Alerts
1. Cloudflare Dashboard → **Notifications**
2. Create alert for high KV usage
3. Monitor Gmail API quota

---

## ❌ Troubleshooting

### Problem: "Invalid Refresh Token"
**Solution:**
1. Re-run OAuth Playground
2. Get new refresh token
3. Update with: `wrangler secret put REFRESH_TOKEN`

### Problem: "Gmail API 403 Error"
**Solution:**
1. Go to Google Cloud Console
2. **APIs & Services** → Verify Gmail API is enabled
3. Check sender email is authorized

### Problem: "OTP not received"
**Solution:**
1. Check email is not in spam
2. Verify sender email matches SENDER_OPTIONS
3. Check Gmail API quota hasn't exceeded
4. View logs: `npm run logs`

### Problem: "CORS blocked"
**Solution:**
1. Check Access-Control-Allow-Origin in src/index.js
2. Should match your frontend domain
3. Verify browser console for exact error

### Problem: "KV namespace not found"
**Solution:**
1. Verify KV ID in wrangler.toml
2. Run: `wrangler kv namespace list`
3. Update with correct ID

---

## 📚 Key Files Reference

| File | Purpose | Update Frequency |
|------|---------|------------------|
| `src/index.js` | Main worker code | When adding features |
| `wrangler.toml` | Cloudflare config | One-time (KV namespace) |
| `package.json` | npm scripts | Rarely |
| `.env` | Local secrets (dev only) | Per environment |
| `scripts/setup-secrets.js` | Secret management | One-time setup |

---

## 🚀 Future Enhancements

Optional features to add:

1. **Custom Email Templates**
   - Edit `formatEmailRFC2822()` function

2. **Multiple OTP Channels**
   - Add SMS via Twilio
   - Add push notifications

3. **Analytics Dashboard**
   - Track OTP success rates
   - Monitor API usage

4. **Admin Panel**
   - Manage sender addresses
   - View OTP history
   - Export analytics

---

## 📞 Support

- **Issues:** Check [Troubleshooting](#troubleshooting)
- **Docs:** See [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)
- **API Reference:** See [v2/GUIDE.md](./v2/GUIDE.md)
- **Cloudflare Help:** [developers.cloudflare.com](https://developers.cloudflare.com)

---

## ✅ Verification Checklist

- [ ] npm packages installed
- [ ] Wrangler authenticated
- [ ] Google OAuth credentials created
- [ ] Gmail API enabled
- [ ] Refresh token obtained
- [ ] KV namespace created
- [ ] Secrets stored in Wrangler
- [ ] src/index.js updated to use env
- [ ] wrangler.toml has correct KV ID
- [ ] Local dev tested
- [ ] Staging deployment tested
- [ ] CORS restricted (production)
- [ ] Production deployed
- [ ] Production tested
- [ ] Logs monitored

---

**Status:** Ready for Production ✅  
**Version:** 2.0.0  
**Date:** June 2026
