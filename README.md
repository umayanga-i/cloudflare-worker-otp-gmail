

```markdown
# 📧 Gmail-Worker-Bridge Deployment Guide

A streamlined guide to deploying your Gmail API sender on Cloudflare Workers.

---

## ⚙️ 1. Setup Variables
Before deploying, you must enter your credentials into the `index.js` file. These allow the Worker to communicate with Google on your behalf.

### Locate the Configuration Block
Open `index.js` and update the following section:

```javascript
// --- CONFIGURATION ---
const CLIENT_ID = "YOUR_CLIENT_ID.apps.googleusercontent.com";
const CLIENT_SECRET = "YOUR_CLIENT_SECRET";
const REFRESH_TOKEN = "YOUR_REFRESH_TOKEN"; // Paste from your pre-generated JSON

const SENDER_OPTIONS = [
  { label: "Main Gmail", email: "example@gmail.com" },
  { label: "Work Email", email: "info@yourdomain.com" }
];
```

| Variable | Description |
| :--- | :--- |
| **CLIENT_ID** | Found in your Google Cloud Console Credentials. |
| **CLIENT_SECRET** | Found in your Google Cloud Console Credentials. |
| **REFRESH_TOKEN** | The `refresh_token` string from your existing `token.json` file. |
| **SENDER_OPTIONS** | An array of labels and emails authorized to send in your Gmail account. |

---

## 🚀 2. Deployment Instructions

You can deploy this in two ways: via the **Cloudflare Dashboard (Browser)** or **Wrangler (CLI)**.

### Option A: Cloudflare Dashboard (Easiest)
1. Log in to your [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Go to **Workers & Pages** > **Create application** > **Create Worker**.
3. Give it a name (e.g., `gmail-sender`) and click **Deploy**.
4. Click **Edit Code**.
5. Delete all existing code and **paste your updated `index.js`**.
6. Click **Save and Deploy**.

### Option B: Wrangler CLI (Advanced)
1. Install Wrangler: 
   ```bash
   npm install -g wrangler
   ```
2. Authenticate: 
   ```bash
   wrangler login
   ```
3. Initialize and Deploy:
   ```bash
   wrangler deploy
   ```

---

## 🖥️ 3. Usage
1. Open the URL provided by Cloudflare (e.g., `https://gmail-sender.your-name.workers.dev`).
2. Use the **Dropdown Menu** to select your sender address.
3. Input the **Recipient Email**, **Subject**, and **Message**.
4. Click **Send Email**. 
   * *Status messages will appear at the bottom of the card to confirm success or display errors.*

---

## 🔒 Security Note
Since this URL is public, anyone who knows the link can send emails from your account. 
* **Recommendation:** Keep the URL private or add a simple password check in the `fetch` function of the code for extra protection.
```
