#!/usr/bin/env node

/**
 * Setup Secrets Script
 * Interactively sets up Cloudflare Wrangler secrets
 * Run: node scripts/setup-secrets.js
 */

const { execSync } = require('child_process');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const secrets = [
  { name: 'CLIENT_ID', description: 'Your Google Cloud OAuth Client ID' },
  { name: 'CLIENT_SECRET', description: 'Your Google Cloud OAuth Client Secret' },
  { name: 'REFRESH_TOKEN', description: 'Your Gmail API Refresh Token' },
];

async function promptSecret(secret) {
  return new Promise((resolve) => {
    rl.question(
      `\n🔑 Enter ${secret.name}\n   (${secret.description}):\n   > `,
      (answer) => {
        resolve(answer.trim());
      }
    );
  });
}

async function setup() {
  console.log('\n🚀 Cloudflare Wrangler Secrets Setup\n');
  console.log('This will configure your OAuth credentials securely.');
  console.log('Secrets are encrypted and never committed to git.\n');

  for (const secret of secrets) {
    try {
      const value = await promptSecret(secret);
      if (value) {
        console.log(`\n⏳ Setting ${secret.name}...`);
        execSync(`wrangler secret put ${secret.name}`, {
          input: `${value}\n`,
          stdio: 'pipe',
        });
        console.log(`✅ ${secret.name} set successfully`);
      } else {
        console.log(`⏭️  Skipped ${secret.name}`);
      }
    } catch (err) {
      console.error(`❌ Error setting ${secret.name}:`, err.message);
    }
  }

  console.log('\n✨ Secrets setup complete!\n');
  console.log('📝 Update src/index.js to read from env:');
  console.log('   const CLIENT_ID = env.CLIENT_ID;');
  console.log('   const CLIENT_SECRET = env.CLIENT_SECRET;');
  console.log('   const REFRESH_TOKEN = env.REFRESH_TOKEN;\n');

  rl.close();
}

setup().catch(console.error);
