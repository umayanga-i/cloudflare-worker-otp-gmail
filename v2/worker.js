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

const APP_NAME    = "MyApp";           // Shown in email header / subject
const OTP_TTL_MS  = 10 * 60 * 1000;   // OTP valid for 10 minutes
const RL_TTL_SEC  = 5  * 60;          // Rate-limit window: 5 minutes (KV TTL in seconds)
const OTP_TTL_SEC = 10 * 60;          // KV TTL for OTP record in seconds

// ─── CORS HEADERS (tighten allowed origin in production) ───────────────────
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ───────────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method;

    // Preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (method === "POST" && url.pathname === "/send-otp") {
      return handleSendOTP(request, env);
    }

    if (method === "POST" && url.pathname === "/verify-otp") {
      return handleVerifyOTP(request, env);
    }

    // Default: serve built-in test UI
    return new Response(generateHTML(), {
      headers: { "Content-Type": "text/html;charset=UTF-8", ...CORS },
    });
  },
};

// ───────────────────────────────────────────────────────────────────────────
// ROUTE: POST /send-otp
// Body: { "to": "user@example.com", "sender": "you@gmail.com" (optional) }
// ───────────────────────────────────────────────────────────────────────────
async function handleSendOTP(request, env) {
  try {
    const body   = await request.json();
    const to     = (body.to || "").trim().toLowerCase();
    const sender = body.sender || SENDER_OPTIONS[0].email;

    // ── Input validation ────────────────────────────────────────────────
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return jsonResponse(400, { success: false, error: "Invalid email address." });
    }
    if (!SENDER_OPTIONS.some(s => s.email === sender)) {
      return jsonResponse(400, { success: false, error: "Sender address not allowed." });
    }

    // ── Rate-limit check ────────────────────────────────────────────────
    const rlKey = `rl:${to}`;
    const rlHit = await env.OTP_STORE.get(rlKey);
    if (rlHit) {
      return jsonResponse(429, {
        success: false,
        error: "An OTP was already sent to this address within the last 5 minutes. Please wait before requesting another.",
      });
    }

    // ── Generate OTP ────────────────────────────────────────────────────
    const otp       = generateOTP();
    const expiresAt = Date.now() + OTP_TTL_MS;

    // ── Persist OTP + set rate-limit sentinel ────────────────────────────
    await Promise.all([
      env.OTP_STORE.put(`otp:${to}`, JSON.stringify({ otp, expiresAt }), { expirationTtl: OTP_TTL_SEC }),
      env.OTP_STORE.put(rlKey, "1", { expirationTtl: RL_TTL_SEC }),
    ]);

    // ── Refresh Gmail access token ────────────────────────────────────────
    const accessToken = await refreshAccessToken();

    // ── Build & send email ─────────────────────────────────────────────────
    const html = buildEmailHTML(otp, APP_NAME);
    await sendGmailHTML(accessToken, sender, to, `Your ${APP_NAME} Verification Code`, html);

    return jsonResponse(200, { success: true, message: `OTP sent to ${to}. Valid for 10 minutes.` });

  } catch (err) {
    console.error("send-otp error:", err);
    return jsonResponse(500, { success: false, error: err.message });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// ROUTE: POST /verify-otp
// Body: { "email": "user@example.com", "otp": "123456" }
// ───────────────────────────────────────────────────────────────────────────
async function handleVerifyOTP(request, env) {
  try {
    const body  = await request.json();
    const email = (body.email || "").trim().toLowerCase();
    const otp   = (body.otp   || "").trim();

    if (!email || !otp) {
      return jsonResponse(400, { success: false, error: "email and otp are required." });
    }

    const record = await env.OTP_STORE.get(`otp:${email}`);
    if (!record) {
      return jsonResponse(404, { success: false, verified: false, error: "No OTP found for this email. It may have expired or was never sent." });
    }

    const { otp: storedOTP, expiresAt } = JSON.parse(record);

    // ── Expiry check ────────────────────────────────────────────────────
    if (Date.now() > expiresAt) {
      await env.OTP_STORE.delete(`otp:${email}`);
      return jsonResponse(410, { success: false, verified: false, error: "OTP has expired. Please request a new one." });
    }

    // ── Constant-time comparison (prevent timing attacks) ──────────────
    const match = timingSafeEqual(otp, storedOTP);

    if (match) {
      // Invalidate OTP immediately after successful verification
      await env.OTP_STORE.delete(`otp:${email}`);
      return jsonResponse(200, { success: true, verified: true, message: "OTP verified successfully." });
    } else {
      return jsonResponse(200, { success: true, verified: false, message: "Incorrect OTP. Please try again." });
    }

  } catch (err) {
    console.error("verify-otp error:", err);
    return jsonResponse(500, { success: false, error: err.message });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// HELPERS
// ───────────────────────────────────────────────────────────────────────────

function generateOTP() {
  // Cryptographically random 6-digit number, zero-padded
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1_000_000).padStart(6, "0");
}

/** Naive constant-time string comparison (same length strings) */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function refreshAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type:    "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Failed to refresh Gmail access token.");
  return data.access_token;
}

async function sendGmailHTML(accessToken, from, to, subject, htmlBody) {
  // RFC 2822 with MIME multipart so HTML renders in mail clients
  const boundary = "----=_OTPWorkerBoundary";
  const raw = [
    `From: ${APP_NAME} <${from}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="utf-8"`,
    ``,
    `Your ${APP_NAME} verification code is: ${htmlBody.match(/\d{6}/)?.[0] ?? "N/A"}`,
    `Valid for 10 minutes. Do not share this code.`,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="utf-8"`,
    ``,
    htmlBody,
    ``,
    `--${boundary}--`,
  ].join("\r\n");

  const encoded = btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const res = await fetch("https://www.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: encoded }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Gmail API error: ${detail}`);
  }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// EMAIL HTML TEMPLATE
// ───────────────────────────────────────────────────────────────────────────
function buildEmailHTML(otp, appName) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${appName} — Verification Code</title>
</head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

          <!-- ── HEADER LOGO BAR ── -->
          <tr>
            <td align="center" style="background:#1a1f36;border-radius:12px 12px 0 0;padding:28px 40px;">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:middle;padding-right:12px;">
                    <!-- Shield icon SVG inline -->
                    <svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M18 3L5 8.5V18C5 25.18 10.58 31.89 18 33C25.42 31.89 31 25.18 31 18V8.5L18 3Z" fill="#4f8ef7"/>
                      <path d="M14 18l3 3 6-6" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </td>
                  <td style="vertical-align:middle;">
                    <span style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">${appName}</span>
                    <span style="color:#7b8cde;font-size:13px;display:block;margin-top:1px;letter-spacing:0.5px;">SECURITY</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- ── BODY ── -->
          <tr>
            <td style="background:#ffffff;padding:40px 40px 32px;">

              <p style="margin:0 0 8px;color:#6b7280;font-size:13px;text-transform:uppercase;letter-spacing:1px;font-weight:600;">One-Time Passcode</p>
              <h1 style="margin:0 0 20px;color:#1a1f36;font-size:26px;font-weight:700;line-height:1.2;">Verify your identity</h1>

              <p style="margin:0 0 28px;color:#374151;font-size:15px;line-height:1.6;">
                Someone requested a verification code for your account. Use the code below to continue. 
                If you didn't request this, you can safely ignore this email.
              </p>

              <!-- OTP CODE BOX -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                <tr>
                  <td align="center" style="background:#f0f4ff;border:2px dashed #4f8ef7;border-radius:10px;padding:24px 16px;">
                    <p style="margin:0 0 6px;color:#6b7280;font-size:12px;letter-spacing:1.5px;font-weight:600;text-transform:uppercase;">Your code</p>
                    <span style="font-size:46px;font-weight:800;letter-spacing:12px;color:#1a1f36;font-family:'Courier New',monospace;">${otp}</span>
                  </td>
                </tr>
              </table>

              <!-- TIMER NOTE -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
                <tr>
                  <td style="background:#fff7ed;border-left:4px solid #f59e0b;border-radius:0 6px 6px 0;padding:12px 16px;">
                    <p style="margin:0;color:#92400e;font-size:13px;line-height:1.5;">
                      ⏱ This code expires in <strong>10 minutes</strong>. Do not share it with anyone.
                    </p>
                  </td>
                </tr>
              </table>

              <p style="margin:0;color:#9ca3af;font-size:13px;line-height:1.6;">
                Didn't request this code? Your account credentials may be compromised. 
                We recommend <a href="#" style="color:#4f8ef7;text-decoration:none;font-weight:600;">securing your account</a> immediately.
              </p>
            </td>
          </tr>

          <!-- ── FOOTER ── -->
          <tr>
            <td style="background:#f8fafc;border-radius:0 0 12px 12px;padding:20px 40px;border-top:1px solid #e5e7eb;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td>
                    <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.6;">
                      © ${new Date().getFullYear()} ${appName}. This is an automated security message — please do not reply.<br>
                      You're receiving this because a sign-in was attempted with your email address.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ───────────────────────────────────────────────────────────────────────────
// BUILT-IN TEST UI (served at GET /)
// ───────────────────────────────────────────────────────────────────────────
function generateHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OTP Worker — Test Console</title>
  <style>
    :root {
      --bg: #0f1117;
      --surface: #1a1f2e;
      --border: #2a3040;
      --primary: #4f8ef7;
      --success: #10b981;
      --warn: #f59e0b;
      --danger: #ef4444;
      --text: #e2e8f0;
      --muted: #64748b;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .header {
      text-align: center;
      margin-bottom: 40px;
    }
    .logo {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      margin-bottom: 8px;
    }
    .logo-text { font-size: 24px; font-weight: 800; letter-spacing: -0.5px; }
    .logo-sub  { color: var(--muted); font-size: 13px; letter-spacing: 1px; text-transform: uppercase; }
    .badge {
      display: inline-block;
      background: #1e293b;
      border: 1px solid var(--border);
      color: var(--primary);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 1px;
      text-transform: uppercase;
      padding: 4px 10px;
      border-radius: 4px;
      margin-top: 8px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      max-width: 820px;
      width: 100%;
    }
    @media(max-width:640px) { .grid { grid-template-columns: 1fr; } }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 28px;
    }
    .card-title {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 1.5px;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 20px;
    }
    label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--muted);
      letter-spacing: 0.5px;
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    input, select {
      width: 100%;
      background: #0f1117;
      border: 1px solid var(--border);
      color: var(--text);
      padding: 11px 14px;
      border-radius: 8px;
      font-size: 14px;
      margin-bottom: 16px;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus, select:focus { border-color: var(--primary); }
    select option { background: #1a1f2e; }
    button {
      width: 100%;
      background: var(--primary);
      color: #fff;
      border: none;
      padding: 13px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      letter-spacing: 0.3px;
      transition: opacity 0.2s, transform 0.1s;
    }
    button:hover:not(:disabled) { opacity: 0.88; transform: translateY(-1px); }
    button:disabled { opacity: 0.4; cursor: not-allowed; transform: none; }
    .status {
      margin-top: 14px;
      padding: 11px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      display: none;
    }
    .status.show { display: block; }
    .status.ok   { background: #052e16; color: var(--success); border: 1px solid #064e3b; }
    .status.fail { background: #1c0a0a; color: var(--danger);  border: 1px solid #450a0a; }
    .status.warn { background: #1c1200; color: var(--warn);    border: 1px solid #451a03; }
    .otp-input {
      font-size: 22px !important;
      letter-spacing: 8px !important;
      text-align: center;
      font-family: 'Courier New', monospace;
    }
    code {
      background: #0f1117;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 12px;
      color: var(--primary);
    }
    .endpoint-list {
      list-style: none;
      margin-top: 16px;
    }
    .endpoint-list li {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 0;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
    }
    .endpoint-list li:last-child { border-bottom: none; }
    .method {
      font-weight: 800;
      font-size: 10px;
      padding: 3px 7px;
      border-radius: 4px;
      background: #172554;
      color: #93c5fd;
    }
    .path { color: var(--text); font-family: monospace; }
    .desc { color: var(--muted); font-size: 12px; margin-left: auto; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">
      <svg width="32" height="32" viewBox="0 0 36 36" fill="none">
        <path d="M18 3L5 8.5V18C5 25.18 10.58 31.89 18 33C25.42 31.89 31 25.18 31 18V8.5L18 3Z" fill="#4f8ef7"/>
        <path d="M14 18l3 3 6-6" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="logo-text">OTP Worker</span>
    </div>
    <div class="logo-sub">Cloudflare Worker — Test Console</div>
    <span class="badge">Development Only</span>
  </div>

  <div class="grid">
    <!-- SEND OTP -->
    <div class="card">
      <div class="card-title">① Send OTP</div>
      <label>From (Sender)</label>
      <select id="sender">
        ${SENDER_OPTIONS.map(o => `<option value="${o.email}">${o.label} — ${o.email}</option>`).join('')}
      </select>
      <label>To (Recipient)</label>
      <input type="email" id="sendTo" placeholder="user@example.com">
      <button id="sendBtn" onclick="sendOTP()">Send Verification Code</button>
      <div class="status" id="sendStatus"></div>
    </div>

    <!-- VERIFY OTP -->
    <div class="card">
      <div class="card-title">② Verify OTP</div>
      <label>Email Address</label>
      <input type="email" id="verifyEmail" placeholder="user@example.com">
      <label>Enter OTP</label>
      <input type="text" id="otpInput" class="otp-input" placeholder="000000" maxlength="6" oninput="this.value=this.value.replace(/\\D/g,'')">
      <button id="verifyBtn" onclick="verifyOTP()">Verify Code</button>
      <div class="status" id="verifyStatus"></div>
    </div>

    <!-- ENDPOINTS REFERENCE -->
    <div class="card" style="grid-column: span 2;">
      <div class="card-title">API Reference</div>
      <ul class="endpoint-list">
        <li>
          <span class="method">POST</span>
          <span class="path">/send-otp</span>
          <span class="desc">Body: <code>{ "to": "email", "sender": "email" }</code></span>
        </li>
        <li>
          <span class="method">POST</span>
          <span class="path">/verify-otp</span>
          <span class="desc">Body: <code>{ "email": "email", "otp": "6digits" }</code></span>
        </li>
      </ul>
      <p style="margin-top:16px;color:var(--muted);font-size:12px;line-height:1.7;">
        Rate limit: same email cannot request a new OTP for <strong style="color:var(--text)">5 minutes</strong>. 
        OTPs are valid for <strong style="color:var(--text)">10 minutes</strong> and are invalidated after first successful verification.
      </p>
    </div>
  </div>

  <script>
    async function sendOTP() {
      const btn    = document.getElementById('sendBtn');
      const status = document.getElementById('sendStatus');
      const to     = document.getElementById('sendTo').value.trim();
      const sender = document.getElementById('sender').value;

      if (!to) return showStatus(status, 'warn', '⚠️ Enter a recipient email.');

      btn.disabled = true;
      showStatus(status, '', '⏳ Requesting OTP...');

      try {
        const res  = await fetch('/send-otp', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ to, sender }) });
        const data = await res.json();
        if (data.success) {
          showStatus(status, 'ok', '✅ ' + data.message);
          // Pre-fill verify email
          document.getElementById('verifyEmail').value = to;
        } else {
          showStatus(status, 'fail', '❌ ' + (data.error || 'Unknown error'));
        }
      } catch(e) {
        showStatus(status, 'fail', '❌ Network error: ' + e.message);
      } finally {
        btn.disabled = false;
      }
    }

    async function verifyOTP() {
      const btn    = document.getElementById('verifyBtn');
      const status = document.getElementById('verifyStatus');
      const email  = document.getElementById('verifyEmail').value.trim();
      const otp    = document.getElementById('otpInput').value.trim();

      if (!email || otp.length !== 6) return showStatus(status, 'warn', '⚠️ Enter email and a 6-digit code.');

      btn.disabled = true;
      showStatus(status, '', '⏳ Verifying...');

      try {
        const res  = await fetch('/verify-otp', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email, otp }) });
        const data = await res.json();
        if (!data.success) {
          showStatus(status, 'fail', '❌ ' + (data.error || 'Error'));
        } else if (data.verified) {
          showStatus(status, 'ok', '✅ ' + data.message);
          document.getElementById('otpInput').value = '';
        } else {
          showStatus(status, 'fail', '❌ ' + data.message);
        }
      } catch(e) {
        showStatus(status, 'fail', '❌ Network error: ' + e.message);
      } finally {
        btn.disabled = false;
      }
    }

    function showStatus(el, type, msg) {
      el.className = 'status show' + (type ? ' ' + type : '');
      el.textContent = msg;
    }
  </script>
</body>
</html>`;
}
