# OTP Worker

A tiny [Cloudflare Worker](https://workers.cloudflare.com/) that emails one-time passwords (OTP) through the Gmail API and verifies them. It includes a built-in test page, so you can try the whole flow from your browser.

## Features

- Sends a 6-digit OTP by email from one of several sender addresses
- Verifies the code the user enters (one-time use, 10-minute expiry)
- Rate limiting: one OTP per email every 5 minutes, and 10 sends per IP per hour
- Brute-force protection: the OTP is deleted after 5 wrong attempts
- Cryptographically secure code generation and constant-time comparison
- Clean test UI with a 6-box code input, resend countdown and dark mode
- No dependencies and no build step: a single `worker.js` file

## API

### `POST /send-otp`

```json
{ "to": "user@example.com", "sender": "you@gmail.com" }
```

`sender` is optional and must match one of the addresses in `SENDER_OPTIONS`.

| Status | Meaning |
| ------ | ------- |
| 200 | OTP sent |
| 400 | Invalid email, invalid JSON, or sender not allowed |
| 429 | Rate limit hit (per email or per IP) |
| 502 | Gmail failed to send (see Worker logs) |

### `POST /verify-otp`

```json
{ "email": "user@example.com", "otp": "123456" }
```

Success response: `{ "success": true, "verified": true }`
Wrong code response: `{ "success": true, "verified": false }`

| Status | Meaning |
| ------ | ------- |
| 200 | Code checked (`verified` is true or false) |
| 404 | No OTP found for this email |
| 410 | OTP expired |
| 429 | Too many wrong attempts |

### `GET /`

The built-in test page.

## Setup (Cloudflare dashboard, no command line)

### 1. Get Gmail API credentials

1. Open the [Google Cloud Console](https://console.cloud.google.com/), create a project, and enable the **Gmail API**.
2. Go to **APIs & Services → OAuth consent screen** and configure it. Publish the app to **Production**, otherwise refresh tokens expire after 7 days.
3. Go to **Credentials → Create credentials → OAuth client ID** (type: Web application). Add `https://developers.google.com/oauthplayground` as an authorized redirect URI.
4. Open the [OAuth Playground](https://developers.google.com/oauthplayground), click the gear icon, tick **Use your own OAuth credentials**, and enter your client ID and secret.
5. In Step 1, enter the scope `https://www.googleapis.com/auth/gmail.send`, authorize, then in Step 2 click **Exchange authorization code for tokens**. Copy the **refresh token**.

### 2. Create the KV namespace

In the Cloudflare dashboard go to **Storage & Databases → KV → Create a namespace** and name it `OTP_STORE`.

### 3. Create the Worker

1. Go to **Workers & Pages → Create → Create Worker**, give it a name, and deploy the starter code.
2. Open the Worker → **Settings → Bindings → Add → KV namespace**. Set the variable name to exactly `OTP_STORE` and select your namespace.
3. Click **Edit code**, replace everything with the contents of `worker.js`, and fill in the configuration block at the top (see below).
4. Click **Deploy** and open your `*.workers.dev` URL to use the test page.

## Configuration

Edit the block at the top of `worker.js`:

```js
const CLIENT_ID     = "YOUR_CLIENT_ID.apps.googleusercontent.com";
const CLIENT_SECRET = "YOUR_CLIENT_SECRET";
const REFRESH_TOKEN = "YOUR_REFRESH_TOKEN";

const SENDER_OPTIONS = [
  { label: "Gmail (Personal)", email: "you@gmail.com" },
  { label: "Domain One",       email: "you@yourdomain1.com" },
  { label: "Domain Two",       email: "you@yourdomain2.com" },
];
```

Other settings (`APP_NAME`, `OTP_TTL_SEC`, `RL_TTL_SEC`, `IP_LIMIT`, `MAX_ATTEMPTS`) are just below it.

> **Never commit real credentials.** This repository contains placeholders only. Put your real values in the copy you paste into the Cloudflare dashboard, not in the GitHub copy.

**Using other sender domains:** Gmail only honors a `From:` address that is configured under **Gmail → Settings → Accounts → Send mail as** for the authenticated account. Otherwise it rewrites the sender to the account's own address.

## Using it from your app

```js
// 1) Send the code
await fetch("https://YOUR-WORKER.workers.dev/send-otp", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ to: "user@example.com" }),
});

// 2) Verify the code
const res = await fetch("https://YOUR-WORKER.workers.dev/verify-otp", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "user@example.com", otp: "123456" }),
});
const { verified } = await res.json();
```

Do not rely on a `verified: true` that browser code decides on its own. Gate something on your server (such as creating a session) after calling `/verify-otp` server-side.

## Security notes

- Restrict CORS: the Worker sends `Access-Control-Allow-Origin: *`. Change `CORS` in `worker.js` to your own site's origin in production.
- Consider adding [Cloudflare Turnstile](https://www.cloudflare.com/products/turnstile/) to the send form to stop bots from using your Gmail quota.
- Rotate your OAuth secret and refresh token immediately if they are ever exposed.
- Workers KV is eventually consistent, so the attempt counter can be bypassed by many parallel requests. For strict guarantees, use a Durable Object.

## Troubleshooting

| Problem | Fix |
| ------- | --- |
| `KV binding OTP_STORE is missing` | Add the KV binding under Settings → Bindings, with the exact name `OTP_STORE` |
| `Could not send the email` | Open the Worker's **Logs** and click Send again to see Google's exact error |
| `invalid_grant` in logs | Refresh token expired or revoked. Create a new one, and publish the OAuth app to Production |
| `insufficient authentication scopes` | Re-create the token with the `gmail.send` scope |
| Email arrives from the wrong address | Add the address under Gmail → Send mail as |
| `Unexpected token '<'` | You are hitting an old deployment. Re-deploy the latest code |

## License

MIT.
