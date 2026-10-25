// ─── CONFIGURATION (move secrets to `wrangler secret put` in production) ───
const CLIENT_ID     = "YOUR_CLIENT_ID.apps.googleusercontent.com";
const CLIENT_SECRET = "YOUR_CLIENT_SECRET";
const REFRESH_TOKEN = "YOUR_REFRESH_TOKEN";

const SENDER_OPTIONS = [
  { label: "Gmail (Personal)", email: "you@gmail.com" },
  { label: "Domain One",       email: "you@yourdomain1.com" },
  { label: "Domain Two",       email: "you@yourdomain2.com" },
];

const APP_NAME      = "MyApp";
const OTP_TTL_SEC   = 10 * 60;   // OTP validity
const RL_TTL_SEC    = 5 * 60;    // per-email cooldown
const IP_LIMIT      = 10;        // max sends per IP per hour
const IP_WINDOW_SEC = 60 * 60;
const MAX_ATTEMPTS  = 5;         // wrong guesses allowed per OTP

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

let cachedToken = { value: null, exp: 0 };

/**
 * OTP WORKER — Cloudflare Worker
 *   POST /send-otp    { to, sender? }
 *   POST /verify-otp  { email, otp }
 *   GET  /            test UI
 *
 * Requires a KV namespace bound with variable name: OTP_STORE
 */
export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname.replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      if (method === "POST" && path === "/send-otp")   return await handleSendOTP(request, env);
      if (method === "POST" && path === "/verify-otp") return await handleVerifyOTP(request, env);

      if (method === "GET" && path === "/") {
        return new Response(generateHTML(), {
          headers: { "Content-Type": "text/html;charset=UTF-8", ...CORS },
        });
      }
      return json(404, { success: false, error: `Route not found: ${method} ${path}` });
    } catch (err) {
      console.error("Unhandled error:", err);
      return json(500, { success: false, error: "Internal server error." });
    }
  },
};

/* ───────────────────────── Handlers ───────────────────────── */

async function handleSendOTP(request, env) {
  if (!env.OTP_STORE) {
    return json(500, { success: false, error: "KV binding OTP_STORE is missing. Add it in Settings → Bindings." });
  }

  let body;
  try { body = await request.json(); }
  catch { return json(400, { success: false, error: "Body must be valid JSON." }); }

  const to     = String(body.to || "").trim().toLowerCase();
  const sender = body.sender || SENDER_OPTIONS[0].email;

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || to.length > 254) {
    return json(400, { success: false, error: "Invalid email address." });
  }
  if (!SENDER_OPTIONS.some((s) => s.email === sender)) {
    return json(400, { success: false, error: "Sender address not allowed." });
  }

  // Per-IP limit
  const ip      = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipKey   = `ip:${ip}`;
  const ipCount = parseInt((await env.OTP_STORE.get(ipKey)) || "0", 10);
  if (ipCount >= IP_LIMIT) {
    return json(429, { success: false, error: "Too many requests. Try again later." });
  }

  // Per-email cooldown
  const rlKey = `rl:${to}`;
  if (await env.OTP_STORE.get(rlKey)) {
    return json(429, {
      success: false,
      error: "An OTP was already sent to this address in the last 5 minutes. Please wait.",
      retryAfter: RL_TTL_SEC,
    });
  }

  await env.OTP_STORE.put(rlKey, "1", { expirationTtl: RL_TTL_SEC });
  await env.OTP_STORE.put(ipKey, String(ipCount + 1), { expirationTtl: IP_WINDOW_SEC });

  const otp = generateOTP();
  const accessToken = await getAccessToken();
  const sent = accessToken ? await sendOTPEmail(sender, to, otp, accessToken) : false;

  if (!sent) {
    await env.OTP_STORE.delete(rlKey); // don't lock the user out on failure
    return json(502, { success: false, error: "Could not send the email. Check Gmail credentials (see Worker logs)." });
  }

  const expiresAt = Date.now() + OTP_TTL_SEC * 1000;
  await env.OTP_STORE.put(`otp:${to}`, JSON.stringify({ otp, expiresAt, attempts: 0 }), {
    expirationTtl: OTP_TTL_SEC,
  });

  return json(200, {
    success: true,
    message: `OTP sent to ${to}. Valid for 10 minutes.`,
    cooldown: RL_TTL_SEC,
  });
}

async function handleVerifyOTP(request, env) {
  if (!env.OTP_STORE) {
    return json(500, { success: false, error: "KV binding OTP_STORE is missing. Add it in Settings → Bindings." });
  }

  let body;
  try { body = await request.json(); }
  catch { return json(400, { success: false, error: "Body must be valid JSON." }); }

  const email = String(body.email || "").trim().toLowerCase();
  const otp   = String(body.otp || "").trim();
  if (!email || !otp) return json(400, { success: false, error: "email and otp are required." });

  const key    = `otp:${email}`;
  const stored = await env.OTP_STORE.get(key);
  if (!stored) {
    return json(404, { success: false, verified: false, error: "No OTP found. Request a new one." });
  }

  const rec = JSON.parse(stored);
  if (Date.now() > rec.expiresAt) {
    await env.OTP_STORE.delete(key);
    return json(410, { success: false, verified: false, error: "OTP has expired." });
  }

  rec.attempts = (rec.attempts || 0) + 1;
  if (rec.attempts > MAX_ATTEMPTS) {
    await env.OTP_STORE.delete(key);
    return json(429, { success: false, verified: false, error: "Too many attempts. Request a new code." });
  }

  if (!constantTimeCompare(otp, rec.otp)) {
    const remaining = Math.max(60, Math.floor((rec.expiresAt - Date.now()) / 1000)); // KV min TTL = 60
    await env.OTP_STORE.put(key, JSON.stringify(rec), { expirationTtl: remaining });
    return json(200, { success: true, verified: false, message: "Incorrect OTP." });
  }

  await env.OTP_STORE.delete(key); // one-time use
  return json(200, { success: true, verified: true, message: "OTP verified successfully." });
}

/* ───────────────────────── Helpers ───────────────────────── */

function generateOTP() {
  const limit = 4294000000; // multiple of 1,000,000 below 2^32 (removes modulo bias)
  const buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return String(buf[0] % 1000000).padStart(6, "0");
}

function constantTimeCompare(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function getAccessToken() {
  if (cachedToken.value && Date.now() < cachedToken.exp) return cachedToken.value;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: REFRESH_TOKEN,
        grant_type:    "refresh_token",
      }),
    });
    if (!res.ok) {
      console.error("Token refresh failed:", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    cachedToken = { value: data.access_token, exp: Date.now() + (data.expires_in - 120) * 1000 };
    return cachedToken.value;
  } catch (err) {
    console.error("Token refresh error:", err);
    return null;
  }
}

async function sendOTPEmail(sender, recipient, otp, accessToken) {
  try {
    const raw = base64Url(buildMime(sender, recipient, otp));
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) {
      console.error("Gmail API error:", res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error("Send email error:", err);
    return false;
  }
}

function buildMime(sender, recipient, otp) {
  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#f4f6f8;font-family:Arial,sans-serif;">
  <div style="max-width:460px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;text-align:center;">
    <h2 style="margin:0 0 8px;color:#222;">${APP_NAME} verification code</h2>
    <p style="color:#666;font-size:15px;margin:0 0 24px;">Enter this code within 10 minutes:</p>
    <div style="background:#e8f0fe;color:#1a56db;font-size:32px;font-weight:bold;letter-spacing:8px;padding:16px;border-radius:8px;">${otp}</div>
    <p style="color:#999;font-size:12px;margin:24px 0 0;">If you didn't request this code, you can safely ignore this email.</p>
  </div>
</body></html>`;

  const bodyB64 = base64Std(html).replace(/(.{76})/g, "$1\r\n");

  return [
    `From: ${APP_NAME} <${sender}>`,
    `To: ${recipient}`,
    `Subject: Your ${APP_NAME} verification code`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: base64`,
    ``,
    bodyB64,
  ].join("\r\n");
}

function base64Std(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64Url(str) {
  return base64Std(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

/* ───────────────────────── Test UI ───────────────────────── */

function generateHTML() {
  const senders = SENDER_OPTIONS
    .map((s) => `<option value="${s.email}">${s.label} — ${s.email}</option>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${APP_NAME} · Verify OTP</title>
<style>
  :root{
    --bg:#f3f5f9; --card:#fff; --text:#1c2230; --muted:#667085; --border:#d9dee7;
    --primary:#3b5bfd; --primary-h:#2f49d1; --ok-bg:#e7f7ee; --ok:#157347; --err-bg:#fdecec; --err:#b42318;
  }
  @media (prefers-color-scheme: dark){
    :root{ --bg:#0f1420; --card:#171d2c; --text:#eef1f7; --muted:#97a0b3; --border:#2a3248;
           --ok-bg:#12301f; --ok:#6ee7a0; --err-bg:#3a1717; --err:#ff9b94; }
  }
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;
       background:var(--bg);color:var(--text);font-family:-apple-system,Segoe UI,Roboto,sans-serif}
  .card{width:100%;max-width:420px;background:var(--card);border-radius:16px;padding:32px;
        box-shadow:0 10px 30px rgba(0,0,0,.08)}
  .icon{width:52px;height:52px;border-radius:14px;background:var(--primary);color:#fff;
        display:grid;place-items:center;font-size:26px;margin:0 auto 16px}
  .icon.ok{background:var(--ok)}
  h1{margin:0 0 6px;font-size:22px;text-align:center}
  p.sub{margin:0 0 24px;color:var(--muted);font-size:14px;text-align:center;line-height:1.5}
  label{display:block;margin:0 0 6px;font-size:13px;font-weight:600;color:var(--muted)}
  input,select{width:100%;padding:12px 14px;border:1px solid var(--border);border-radius:10px;
       background:transparent;color:var(--text);font-size:15px;outline:none;margin-bottom:16px}
  input:focus,select:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(59,91,253,.18)}
  select option{color:#000}
  button{width:100%;padding:13px;border:0;border-radius:10px;background:var(--primary);color:#fff;
         font-size:15px;font-weight:600;cursor:pointer;display:flex;gap:8px;justify-content:center;align-items:center}
  button:hover:not(:disabled){background:var(--primary-h)}
  button:disabled{opacity:.6;cursor:not-allowed}
  button.link{background:none;color:var(--primary);font-size:14px;font-weight:600;padding:8px;margin-top:8px;width:auto;display:inline-flex}
  button.link:hover:not(:disabled){background:none;text-decoration:underline}
  .row{display:flex;justify-content:space-between;gap:8px}
  .spin{width:16px;height:16px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;
        border-radius:50%;animation:s .7s linear infinite;display:none}
  button.loading .spin{display:inline-block}
  @keyframes s{to{transform:rotate(360deg)}}
  .status{margin-top:16px;padding:12px 14px;border-radius:10px;font-size:14px;display:none}
  .status.ok{display:block;background:var(--ok-bg);color:var(--ok)}
  .status.err{display:block;background:var(--err-bg);color:var(--err)}
  .digits{display:flex;gap:8px;justify-content:center;margin-bottom:20px}
  .digits input{width:48px;height:56px;padding:0;margin:0;text-align:center;font-size:24px;font-weight:700}
  .digits.shake{animation:sh .35s}
  @keyframes sh{20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}
  .hidden{display:none}
  .email-chip{font-weight:600;color:var(--text)}
</style>
</head>
<body>
  <div class="card">

    <!-- STEP 1: send -->
    <div id="step1">
      <div class="icon">✉️</div>
      <h1>Send verification code</h1>
      <p class="sub">We'll email a 6-digit code that expires in 10 minutes.</p>

      <label for="sender">Send from</label>
      <select id="sender">${senders}</select>

      <label for="to">Recipient email</label>
      <input id="to" type="email" placeholder="user@example.com" autocomplete="email">

      <button id="sendBtn" type="button"><span class="spin"></span><span id="sendText">Send code</span></button>
    </div>

    <!-- STEP 2: verify -->
    <div id="step2" class="hidden">
      <div class="icon">🔐</div>
      <h1>Enter your code</h1>
      <p class="sub">We sent a 6-digit code to<br><span id="emailChip" class="email-chip"></span></p>

      <div class="digits" id="digits">
        <input inputmode="numeric" maxlength="1" autocomplete="one-time-code" aria-label="Digit 1">
        <input inputmode="numeric" maxlength="1" aria-label="Digit 2">
        <input inputmode="numeric" maxlength="1" aria-label="Digit 3">
        <input inputmode="numeric" maxlength="1" aria-label="Digit 4">
        <input inputmode="numeric" maxlength="1" aria-label="Digit 5">
        <input inputmode="numeric" maxlength="1" aria-label="Digit 6">
      </div>

      <button id="verifyBtn" type="button"><span class="spin"></span><span id="verifyText">Verify</span></button>

      <div class="row">
        <button id="resendBtn" class="link" type="button">Resend code</button>
        <button id="changeBtn" class="link" type="button">Change email</button>
      </div>
    </div>

    <!-- STEP 3: success -->
    <div id="step3" class="hidden" style="text-align:center">
      <div class="icon ok">✓</div>
      <h1>Email verified</h1>
      <p class="sub"><span id="okEmail" class="email-chip"></span> has been verified successfully.</p>
      <button id="againBtn" type="button">Verify another email</button>
    </div>

    <div id="status" class="status"></div>
  </div>

<script>
  var $ = function(id){ return document.getElementById(id); };
  var statusEl = $('status');
  var digitInputs = Array.prototype.slice.call(document.querySelectorAll('#digits input'));
  var currentEmail = '';
  var timer = null;

  function show(msg, type){ statusEl.textContent = msg; statusEl.className = 'status ' + type; }
  function hideStatus(){ statusEl.className = 'status'; }
  function setStep(n){
    ['step1','step2','step3'].forEach(function(id, i){ $(id).classList.toggle('hidden', i !== n - 1); });
    hideStatus();
  }
  function setLoading(btn, textEl, on, label){
    btn.disabled = on; btn.classList.toggle('loading', on); textEl.textContent = label;
  }
  async function post(path, payload){
    var res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    var raw = await res.text();
    var data;
    try { data = JSON.parse(raw); }
    catch (e) { throw new Error('Server returned non-JSON (HTTP ' + res.status + '): ' + raw.slice(0, 120)); }
    return { status: res.status, data: data };
  }

  /* ---------- resend cooldown ---------- */
  function startCooldown(sec){
    clearInterval(timer);
    $('resendBtn').disabled = true;
    timer = setInterval(function(){
      if (sec <= 0){ clearInterval(timer); $('resendBtn').disabled = false; $('resendBtn').textContent = 'Resend code'; return; }
      var m = Math.floor(sec / 60), s = String(sec % 60).padStart(2, '0');
      $('resendBtn').textContent = 'Resend in ' + m + ':' + s;
      sec--;
    }, 1000);
  }

  /* ---------- send ---------- */
  async function sendCode(isResend){
    var to = isResend ? currentEmail : $('to').value.trim().toLowerCase();
    var sender = $('sender').value;
    if (!to){ show('Please enter an email address.', 'err'); return; }

    setLoading($('sendBtn'), $('sendText'), true, 'Sending...');
    if (isResend) $('resendBtn').disabled = true;
    hideStatus();

    try {
      var r = await post('/send-otp', { to: to, sender: sender });
      if (r.data.success){
        currentEmail = to;
        $('emailChip').textContent = to;
        setStep(2);
        show(r.data.message, 'ok');
        startCooldown(r.data.cooldown || 300);
        clearDigits(); digitInputs[0].focus();
      } else {
        show(r.data.error || 'Something went wrong.', 'err');
        if (r.status === 429 && r.data.retryAfter && isResend) startCooldown(r.data.retryAfter);
        else if (r.status === 429 && !isResend){
          // code already sent recently: let the user go straight to entering it
          currentEmail = to; $('emailChip').textContent = to; setStep(2);
          show(r.data.error, 'err'); startCooldown(r.data.retryAfter || 300);
        }
      }
    } catch (e) {
      show(e.message, 'err');
      if (isResend) $('resendBtn').disabled = false;
    } finally {
      setLoading($('sendBtn'), $('sendText'), false, 'Send code');
    }
  }

  /* ---------- verify ---------- */
  function getCode(){ return digitInputs.map(function(i){ return i.value; }).join(''); }
  function clearDigits(){ digitInputs.forEach(function(i){ i.value = ''; }); }

  async function verifyCode(){
    var code = getCode();
    if (!/^[0-9]{6}$/.test(code)){ show('Enter all 6 digits.', 'err'); return; }

    setLoading($('verifyBtn'), $('verifyText'), true, 'Verifying...');
    hideStatus();

    try {
      var r = await post('/verify-otp', { email: currentEmail, otp: code });
      if (r.data.verified === true){
        clearInterval(timer);
        $('okEmail').textContent = currentEmail;
        setStep(3);
      } else if (r.data.success === true){
        // wrong code
        show('Incorrect code. Please try again.', 'err');
        var box = $('digits'); box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
        clearDigits(); digitInputs[0].focus();
      } else {
        // expired / not found / too many attempts
        show(r.data.error || 'Verification failed.', 'err');
        clearDigits();
      }
    } catch (e) {
      show(e.message, 'err');
    } finally {
      setLoading($('verifyBtn'), $('verifyText'), false, 'Verify');
    }
  }

  /* ---------- digit boxes behaviour ---------- */
  digitInputs.forEach(function(input, idx){
    input.addEventListener('input', function(){
      input.value = input.value.replace(/[^0-9]/g, '').slice(0, 1);
      if (input.value && idx < 5) digitInputs[idx + 1].focus();
      if (getCode().length === 6) verifyCode();
    });
    input.addEventListener('keydown', function(e){
      if (e.key === 'Backspace' && !input.value && idx > 0) digitInputs[idx - 1].focus();
      if (e.key === 'ArrowLeft' && idx > 0) digitInputs[idx - 1].focus();
      if (e.key === 'ArrowRight' && idx < 5) digitInputs[idx + 1].focus();
      if (e.key === 'Enter') verifyCode();
    });
    input.addEventListener('paste', function(e){
      var text = (e.clipboardData || window.clipboardData).getData('text').replace(/[^0-9]/g, '').slice(0, 6);
      if (!text) return;
      e.preventDefault();
      text.split('').forEach(function(ch, i){ digitInputs[i].value = ch; });
      digitInputs[Math.min(text.length, 5)].focus();
      if (text.length === 6) verifyCode();
    });
  });

  /* ---------- buttons ---------- */
  $('sendBtn').addEventListener('click', function(){ sendCode(false); });
  $('to').addEventListener('keydown', function(e){ if (e.key === 'Enter') sendCode(false); });
  $('verifyBtn').addEventListener('click', verifyCode);
  $('resendBtn').addEventListener('click', function(){ sendCode(true); });
  $('changeBtn').addEventListener('click', function(){ clearInterval(timer); setStep(1); $('to').focus(); });
  $('againBtn').addEventListener('click', function(){ $('to').value = ''; clearDigits(); setStep(1); });
</script>
</body>
</html>`;
}