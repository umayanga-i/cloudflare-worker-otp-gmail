#!/bin/bash

# Setup script - Run once after cloning
# Usage: ./scripts/setup.sh

set -e

echo "🚀 OTP Worker Setup"
echo "==================="
echo ""

# Check dependencies
echo "✓ Checking dependencies..."
command -v node >/dev/null 2>&1 || { echo "❌ Node.js not found"; exit 1; }
command -v wrangler >/dev/null 2>&1 || { echo "❌ Wrangler not found. Install: npm install -g wrangler"; exit 1; }

# Install npm packages
echo "✓ Installing npm packages..."
npm install

# Create .env file
if [ ! -f .env ]; then
  echo "✓ Creating .env file..."
  cp .env.example .env
  echo "📝 Please edit .env with your configuration"
else
  echo "✓ .env already exists"
fi

# Create KV namespace
echo ""
echo "📦 Creating KV namespace..."
echo "   Run: wrangler kv namespace create OTP_STORE"
echo "   Then copy the ID to wrangler.toml"

echo ""
echo "✅ Setup complete!"
echo ""
echo "📋 Next steps:"
echo "   1. Edit .env with your Google OAuth credentials"
echo "   2. Run: wrangler kv namespace create OTP_STORE"
echo "   3. Update wrangler.toml with your KV namespace ID"
echo "   4. Run: node scripts/setup-secrets.js"
echo "   5. Run: npm run deploy"
echo ""
