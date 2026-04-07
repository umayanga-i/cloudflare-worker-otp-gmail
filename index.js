/**
 * GMAIL WORKER BRIDGE
 * A Cloudflare Worker to send emails via Gmail API REST endpoints.
 */

// --- CONFIGURATION ---
// In production, move these to Cloudflare Secrets (wrangler secret put ...)
const CLIENT_ID = "YOUR_CLIENT_ID.apps.googleusercontent.com";
const CLIENT_SECRET = "YOUR_CLIENT_SECRET";
const REFRESH_TOKEN = "YOUR_REFRESH_TOKEN";

const SENDER_OPTIONS = [
  { label: "Gmail (Personal)", email: "you@gmail.com" },
  { label: "Domain One", email: "you@yourdomain1.com" },
  { label: "Domain Two", email: "you@yourdomain2.com" }
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Route: API POST to send email
    if (request.method === "POST" && url.pathname === "/send") {
      return await handleSendEmail(request);
    }

    // Route: Default UI Page
    return new Response(generateHTML(), {
      headers: { "Content-Type": "text/html;charset=UTF-8" },
    });
  },
};

async function handleSendEmail(request) {
  try {
    const { to, sender, subject, body } = await request.json();

    // 1. Refresh Access Token
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
    });
    
    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) throw new Error("Failed to refresh access token.");

    // 2. Format RFC 2822 Email
    const emailContent = [
      `From: ${sender}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset="utf-8"`,
      ``,
      body,
    ].join("\n");

    // 3. URL-Safe Base64 Encode
    const encodedMail = btoa(unescape(encodeURIComponent(emailContent)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // 4. Dispatch to Google API
    const gmailRes = await fetch("https://www.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: encodedMail }),
    });

    if (gmailRes.ok) {
      return new Response(JSON.stringify({ success: true }), { 
        status: 200, 
        headers: { "Content-Type": "application/json" } 
      });
    } else {
      const errDetail = await gmailRes.text();
      return new Response(JSON.stringify({ success: false, error: errDetail }), { status: 400 });
    }
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
  }
}

function generateHTML() {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Worker Mailer</title>
    <style>
      :root { --primary: #4285f4; --bg: #f0f2f5; }
      body { font-family: -apple-system, system-ui, sans-serif; background: var(--bg); display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
      .container { background: white; width: 100%; max-width: 450px; padding: 2rem; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
      h2 { margin-top: 0; color: #333; font-size: 1.5rem; text-align: center; }
      label { display: block; margin: 10px 0 5px; font-weight: 600; font-size: 0.85rem; color: #555; }
      input, select, textarea { width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 6px; box-sizing: border-box; font-size: 1rem; }
      textarea { resize: vertical; min-height: 100px; }
      button { width: 100%; background: var(--primary); color: white; border: none; padding: 14px; border-radius: 6px; font-size: 1rem; font-weight: bold; cursor: pointer; margin-top: 20px; transition: opacity 0.2s; }
      button:disabled { opacity: 0.6; cursor: not-allowed; }
      #status { margin-top: 15px; text-align: center; font-size: 0.9rem; font-weight: 500; }
    </style>
  </head>
  <body>
    <div class="container">
      <h2>Gmail Dispatcher</h2>
      
      <label>From Address</label>
      <select id="sender">
        ${SENDER_OPTIONS.map(opt => `<option value="${opt.email}">${opt.label} (${opt.email})</option>`).join('')}
      </select>

      <label>To Address</label>
      <input type="email" id="to" placeholder="recipient@example.com">

      <label>Subject</label>
      <input type="text" id="subject" placeholder="Enter subject line">

      <label>Message</label>
      <textarea id="body" placeholder="Write your message here..."></textarea>

      <button id="sendBtn" onclick="sendEmail()">Send Email</button>
      <div id="status"></div>
    </div>

    <script>
      async function sendEmail() {
        const btn = document.getElementById('sendBtn');
        const status = document.getElementById('status');
        
        const payload = {
          sender: document.getElementById('sender').value,
          to: document.getElementById('to').value,
          subject: document.getElementById('subject').value,
          body: document.getElementById('body').value
        };

        if(!payload.to || !payload.subject) {
          status.innerText = "⚠️ Recipient and Subject are required.";
          status.style.color = "orange";
          return;
        }

        btn.disabled = true;
        status.innerText = "⏳ Sending via Gmail API...";
        status.style.color = "#666";

        try {
          const res = await fetch('/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          const result = await res.json();
          if (result.success) {
            status.innerText = "✅ Message sent successfully!";
            status.style.color = "green";
            document.getElementById('to').value = '';
            document.getElementById('body').value = '';
          } else {
            throw new Error(result.error || "Unknown error");
          }
        } catch (err) {
          status.innerText = "❌ Error: " + err.message;
          status.style.color = "red";
        } finally {
          btn.disabled = false;
        }
      }
    </script>
  </body>
  </html>
  `;
}
