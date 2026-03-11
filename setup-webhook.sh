#!/bin/bash
# Run this once after deploy to register the Telegram webhook
# Usage: TELEGRAM_TOKEN_HEALTH=xxx RAILWAY_URL=https://tobin-health-xxx.railway.app bash setup-webhook.sh

TOKEN=${TELEGRAM_TOKEN_HEALTH}
URL=${RAILWAY_URL}

curl -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\": \"${URL}/webhook\"}"

echo ""
echo "Webhook set to: ${URL}/webhook"
