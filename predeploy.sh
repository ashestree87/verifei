#!/bin/bash
set -e

echo "Creating queue: verifei-jobs"
npx wrangler queues create verifei-jobs || true

echo "Creating KV namespace: EMAIL_BLOCKLIST"
npx wrangler kv:namespace create EMAIL_BLOCKLIST || true

echo "Creating D1 database: email_verifei"
npx wrangler d1 create email_verifei || true

echo "Applying migrations"
npx wrangler d1 migrations apply email_verifei || true

echo "Setup complete! You can now deploy with: npm run deploy" 