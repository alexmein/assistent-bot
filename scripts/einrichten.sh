#!/usr/bin/env bash
# Schritt 1: Worker veröffentlichen, Secrets setzen, Telegram-Webhook registrieren.
# Das Bot-Token wird verdeckt abgefragt und nie angezeigt; das Webhook-Secret wird erzeugt
# und direkt weitergereicht – du musst es nie sehen.
set -euo pipefail
cd "$(dirname "$0")/.."

npx wrangler whoami >/dev/null 2>&1 || { echo "Erst anmelden: npx wrangler login"; exit 1; }

read -rsp "Telegram-Bot-Token (Eingabe bleibt unsichtbar): " TOKEN; echo
[[ "$TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] || { echo "Das sieht nicht wie ein Bot-Token aus."; exit 1; }
SECRET="$(openssl rand -hex 32)"

echo "→ Worker veröffentlichen …"
DEPLOY_LOG="$(npx wrangler deploy 2>&1)" || { echo "$DEPLOY_LOG"; exit 1; }
WORKER_URL="$(grep -Eo 'https://[a-z0-9.-]+\.workers\.dev' <<<"$DEPLOY_LOG" | head -1)"
[[ -n "$WORKER_URL" ]] || { echo "$DEPLOY_LOG"; echo "Worker-URL nicht gefunden."; exit 1; }
echo "  $WORKER_URL"

echo "→ Secrets setzen …"
printf '%s' "$TOKEN"  | npx wrangler secret put TELEGRAM_BOT_TOKEN >/dev/null
printf '%s' "$SECRET" | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET >/dev/null

echo "→ Webhook bei Telegram registrieren …"
# Token und Secret gehen per stdin an curl, nicht über die Kommandozeile.
curl -sS -K - <<CURL
url = "https://api.telegram.org/bot${TOKEN}/setWebhook"
data-urlencode = "url=${WORKER_URL}/telegram"
data-urlencode = "secret_token=${SECRET}"
data-urlencode = "allowed_updates=[\"message\"]"
data-urlencode = "drop_pending_updates=true"
CURL
echo
unset TOKEN SECRET

cat <<'TXT'

Fertig. Jetzt deine Chat-ID eintragen:
  1. In einem zweiten Terminal:  npx wrangler tail
  2. Dem Bot auf Telegram etwas schreiben → im Log steht „Abgelehnt: chat_id=…“
  3. Hier:  npx wrangler secret put ALLOWED_CHAT_ID   (die Zahl eingeben)
Danach antwortet der Bot dir mit „Echo: …“.
TXT
