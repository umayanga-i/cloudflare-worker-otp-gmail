#!/bin/bash

# Deploy script for OTP Worker
# Usage: ./scripts/deploy.sh [staging|production]

ENV=${1:-staging}

echo "🚀 Deploying OTP Worker to: $ENV"
echo "================================"

if [ "$ENV" = "production" ]; then
  echo "⚠️  WARNING: Deploying to PRODUCTION"
  read -p "Are you sure? (yes/no): " confirm
  if [ "$confirm" != "yes" ]; then
    echo "❌ Deployment cancelled"
    exit 1
  fi
  wrangler deploy --env production
elif [ "$ENV" = "staging" ]; then
  echo "📦 Deploying to staging..."
  wrangler deploy --env staging
else
  echo "Usage: ./scripts/deploy.sh [staging|production]"
  exit 1
fi

echo "✅ Deployment complete!"
