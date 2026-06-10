/**
 * OTP WORKER — Cloudflare Worker
 * ──────────────────────────────
 * POST /send-otp    → generates & emails a 6-digit OTP
 * POST /verify-otp  → validates the OTP the user received
 * GET  /            → built-in test UI
 *
 * Rate-limit: the same email cannot request a new OTP within 5 minutes.
 *
 * Storage: Cloudflare KV namespace bound as OTP_STORE
 *   Key schema:
 *     otp:<email>      → { otp, expiresAt }      TTL = 10 min
 *     rl:<email>       → 1                        TTL =  5 min (rate-limit sentinel)
 */

// ─── CONFIGURATION (move secrets to `wrangler secret put` in production) ───
const CLIENT_ID     = "YOUR_CLIENT_ID.apps.googleusercontent.com";
const CLIENT_SECRET = "YOUR_CLIENT_SECRET";
const REFRESH_TOKEN = "YOUR_REFRESH_TOKEN";

const SENDER_OPTIONS = [
  { label: "Gmail (Personal)", email: "you@gmail.com" },
  { label: "Domain One",       email: "you@yourdomain1.com" },
  { label: "Domain Two",       email: "you@yourdomain2.com" },
];

const APP_NAME    = "MyApp";
const OTP_TTL_MS  = 10 * 60 * 1000;
const RL_TTL_SEC  = 5  * 60;
const OTP_TTL_SEC = 10 * 60;

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (method === "POST" && url.pathname === "/send-otp") {
      return handleSendOTP(request, env);
    }

    if (method === "POST" && url.pathname === "/verify-otp") {
      return handleVerifyOTP(request, env);
    }

    return new Response(generateHTML(), {
      headers: { "Content-Type": "text/html;charset=UTF-8", ...CORS },
    });
  },
};

async function handleSendOTP(request, env) {
  try {
    const body   = await request.json();
    const to     = (body.to || "").trim().toLowerCase();
    const sender = body.sender || SENDER_OPTIONS[0].email;

    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return jsonResponse(400, { success: false, error: "Invalid email address." });
    }
    if (!SENDER_OPTIONS.some(s => s.email === sender)) {
      return jsonResponse(400, { success: false, error: "Sender address not allowed." });
    }

    const rlKey = `rl:${to}`;
    const rlHit = await env.OTP_STORE.get(rlKey);
    if (rlHit) {
      return jsonResponse(429, {
        success: false,
        error: "An OTP was already sent to this address within the last 5 minutes. Please wait before requesting another.",
      });
    }

    const otp       = generateOTP();
    const expiresAt = Date.now() + OTP_TTL_MS;

    await Promise.all([
      env.OTP_STORE.put(`otp:${to}`, JSON.stringify({ otp, expiresAt }), { expirationTtl: OTP_TTL_SEC }),
      env.OTP_STORE.put(rlKey, "1", { expirationTtl: RL_TTL_SEC }),
    ]);

    const accessToken = await refreshAccessToken(env);
    if (!accessToken) {
      return jsonResponse(500, { success: false, error: "Failed to refresh Gmail access token." });
    }

    const emailSuccess = await sendOTPEmail(sender, to, otp, accessToken);
    if (!emailSuccess) {
      return jsonResponse(500, { success: false, error: "Failed to send OTP email." });
    }

    return jsonResponse(200, {
      success: true,
      message: `OTP sent to ${to}. Valid for 10 minutes.`,
    });
  } catch (err) {
    console.error("POST /send-otp error:", err);
    return jsonResponse(500, { success: false, error: err.message });
  }
}

async function handleVerifyOTP(request, env) {
  try {
    const body  = await request.json();
    const email = (body.email || "").trim().toLowerCase();
    const otp   = (body.otp || "").trim();

    if (!email || !otp) {
      return jsonResponse(400, { success: false, error: "email and otp are required." });
    }

    const otpKey = `otp:${email}`;
    const stored = await env.OTP_STORE.get(otpKey);

    if (!stored) {
      return jsonResponse(404, {
        success: false,
        verified: false,
        error: "No OTP found for this email. Request a new one.",
      });
    }

    const { otp: storedOTP, expiresAt } = JSON.parse(stored);

    if (Date.now() > expiresAt) {
      await env.OTP_STORE.delete(otpKey);
      return jsonResponse(410, {
        success: false,
        verified: false,
        error: "OTP has expired.",
      });
    }

    const verified = constantTimeCompare(otp, storedOTP);

    if (!verified) {
      return jsonResponse(200, {
        success: true,
        verified: false,
        message: "Incorrect OTP. Please try again.",
      });
    }

    await env.OTP_STORE.delete(otpKey);

    return jsonResponse(200, {
      success: true,
      verified: true,
      message: "OTP verified successfully.",
    });
  } catch (err) {
    console.error("POST /verify-otp error:", err);
    return jsonResponse(500, { success: false, error: err.message });
  }
}

function generateOTP() {
  const arr = new Uint8Array(3);
  crypto.getRandomValues(arr);
  const num = (arr[0] << 16) | (arr[1] << 8) | arr[2];
  return (num % 1000000).toString().padStart(6, '0');
}

function constantTimeCompare(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function refreshAccessToken(env) {
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      console.error("Token refresh failed:", await response.text());
      return null;
    }

    const data = await response.json();
    return data.access_token || null;
  } catch (err) {
    console.error("Token refresh error:", err);
    return null;
  }
}

async function sendOTPEmail(sender, recipient, otp, accessToken) {
  try {
    const emailContent = formatEmailRFC2822(sender, recipient, otp);
    const encodedMail = base64UrlEncode(emailContent);

    const response = await fetch("https://www.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: encodedMail }),
    });

    if (!response.ok) {
      console.error("Gmail API error:", await response.text());
      return false;
    }

    return true;
  } catch (err) {
    console.error("Send email error:", err);
    return false;
  }
}

function formatEmailRFC2822(sender, recipient, otp) {
  const timestamp = new Date().toUTCString();
  const htmlBody = `
    <html>
      <body style="font-family: Arial, sans-serif; background: #f4f4f4; padding: 20px;">
        <div style="background: white; padding: 30px; border-radius: 8px; max-width: 500px; margin: 0 auto;">
          <h1 style="color: #333; text-align: center;">Your ${APP_NAME} Verification Code</h1>
          <p style="color: #666; text-align: center; font-size: 16px;">
            Enter this code within 10 minutes:
          </p>
          <div style="text-align: center; margin: 20px 0;">
            <p style="background: #e3f2fd; padding: 15px; border-radius: 6px; font-size: 28px; font-weight: bold; letter-spacing: 3px; color: #1976d2;">
              ${otp}
            </p>
          </div>
          <p style="color: #999; text-align: center; font-size: 12px;">
            If you didn't request this code, please ignore this email.
          </p>
        </div>
      </body>
    </html>
  `;

  return [
    `From: ${sender}`,
    `To: ${recipient}`,
    `Subject: ${APP_NAME} Verification Code: ${otp}`,
    `Date: ${timestamp}`,
    `Content-Type: text/html; charset="utf-8"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    htmlBody,
  ].join("\r\n");
}

function base64UrlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function generateHTML() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OTP Worker Test Client</title>
  <style>
    :root { --primary: #1976d2; --success: #388e3c; --error: #d32f2f; --bg: #f5f5f5; }
    body { font-family: -apple-system, sans-serif; background: var(--bg); margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; }
    .header { background: var(--primary); color: white; padding: 20px; border-radius: 8px 8px 0 0; text-align: center; }
    .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .card h2 { margin: 0 0 15px 0; font-size: 18px; color: #333; }
    .form-group { margin-bottom: 15px; }
    label { display: block; margin-bottom: 5px; font-weight: 600; color: #555; font-size: 14px; }
    input, select { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
    button { background: var(--primary); color: white; border: none; padding: 10px 20px; border-radius: 4px; font-weight: 600; cursor: pointer; width: 100%; margin-top: 10px; }
    button:hover { background: #1565c0; }
    .status { padding: 10px; border-radius: 4px; margin-top: 10px; display: none; }
    .status.success { background: #c8e6c9; color: var(--success); display: block; }
    .status.error { background: #ffcdd2; color: var(--error); display: block; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>🔐 OTP Worker</h1></div>
    <div class="card">
      <h2>Configuration</h2>
      <div class="form-group">
        <label>Worker URL</label>
        <input type="text" id="workerUrl" value="http://localhost:8787">
      </div>
      <button onclick="testConnection()">Ping Worker</button>
      <div id="configStatus" class="status"></div>
    </div>
    <div class="card">
      <h2>Send OTP</h2>
      <div class="form-group">
        <label>Email</label>
        <input type="email" id="recipient" placeholder="user@example.com">
      </div>
      <button onclick="sendOTP()">Send Code</button>
      <div id="sendStatus" class="status"></div>
    </div>
    <div class="card">
      <h2>Verify OTP</h2>
      <div class="form-group">
        <label>Email</label>
        <input type="email" id="verifyEmail" placeholder="user@example.com">
      </div>
      <div class="form-group">
        <label>Code</label>
        <input type="text" id="otpCode" placeholder="000000" maxlength="6">
      </div>
      <button onclick="verifyOTP()">Verify</button>
      <div id="verifyStatus" class="status"></div>
    </div>
  </div>
  <script>
    async function testConnection() {
      const url = document.getElementById('workerUrl').value;
      try {
        const res = await fetch(url);
        showStatus('configStatus', res.ok ? 'Connected ✅' : 'Error', res.ok ? 'success' : 'error');
      } catch(e) { showStatus('configStatus', 'Failed', 'error'); }
    }
    async function sendOTP() {
      const url = document.getElementById('workerUrl').value;
      const to = document.getElementById('recipient').value;
      try {
        const res = await fetch(url + '/send-otp', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({to}) });
        const data = await res.json();
        showStatus('sendStatus', data.message || data.error, data.success ? 'success' : 'error');
      } catch(e) { showStatus('sendStatus', e.message, 'error'); }
    }
    async function verifyOTP() {
      const url = document.getElementById('workerUrl').value;
      const email = document.getElementById('verifyEmail').value;
      const otp = document.getElementById('otpCode').value;
      try {
        const res = await fetch(url + '/verify-otp', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email, otp}) });
        const data = await res.json();
        showStatus('verifyStatus', data.message || data.error, data.verified ? 'success' : 'error');
      } catch(e) { showStatus('verifyStatus', e.message, 'error'); }
    }
    function showStatus(id, msg, type) { const el = document.getElementById(id); el.textContent = msg; el.className = 'status ' + type; }
  </script>
</body>
</html>
  `;
}
