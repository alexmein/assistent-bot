# assistent-bot

Telegram-Bot des persönlichen Assistenten. Läuft als Cloudflare Worker.
Regeln, Wissen und Bauplan stehen im Repo `alexmein/Assistent` (`CLAUDE.md`, `docs/bauplan.md`, Entscheidungen 38/39).

## Stand: Schritt 2 von 8 – /status
- `POST /telegram` mit Telegram-Webhook-Secret; alles andere 404/401.
- Antwortet nur im privaten Chat mit `ALLOWED_CHAT_ID`; fremde Chats werden ignoriert (nur die ID wird geloggt, nie Text).
- `/status` liest `docs/status.md` über die GitHub-API (`GITHUB_REPO` in `wrangler.toml`); sonst Echo. `/start` zeigt die Hilfe.

## Secrets (nur per `wrangler secret put`, nie im Repo)
| Name | Woher |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather; `scripts/einrichten.sh` fragt verdeckt ab |
| `TELEGRAM_WEBHOOK_SECRET` | erzeugt `scripts/einrichten.sh` selbst |
| `ALLOWED_CHAT_ID` | aus `npx wrangler tail` nach der ersten Nachricht |
| `GITHUB_TOKEN` | Fine-grained Token von `alexmein`, nur Repo `Assistent`, Contents: Read and write |

## Befehle
```
npm test              # Tests
npm run typecheck
./scripts/einrichten.sh   # Deploy + Secrets + Webhook (einmalig)
npm run deploy        # spätere Deploys
npm run tail          # Live-Log
```
