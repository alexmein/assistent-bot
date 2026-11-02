# assistent-bot

Telegram-Bot des persönlichen Assistenten. Läuft als Cloudflare Worker.
Regeln, Wissen und Bauplan stehen im Repo `alexmein/Assistent` (`CLAUDE.md`, `docs/bauplan.md`, Entscheidungen 38/39).

## Stand: Schritt 3 von 8 – kleine Fragen (nur lesend)
- `POST /telegram` mit Telegram-Webhook-Secret; alles andere 404/401.
- Antwortet nur im privaten Chat mit `ALLOWED_CHAT_ID`; fremde Chats werden ignoriert (nur die ID wird geloggt, nie Text).
- `/status` liest `docs/status.md` über die GitHub-API (`GITHUB_REPO` in `wrangler.toml`). `/start` zeigt die Hilfe.
- Jeder andere Text geht an Claude Haiku 5.5 (`src/ask.ts`): CLAUDE.md (gecacht) + Dashboard + Eingangskorb im Systemprompt,
  einziges Werkzeug `read_file` auf `CLAUDE.md`, `docs|bereiche|monitor|archiv/*.md`. Höchstens 4 Modellaufrufe und
  6 Dateizugriffe pro Frage. Verbrauch und Kosten je Frage stehen im Log (`Verbrauch {...}`), ohne Frage- oder Antworttext.

## Secrets (nur per `wrangler secret put`, nie im Repo)
| Name | Woher |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather; `scripts/einrichten.sh` fragt verdeckt ab |
| `TELEGRAM_WEBHOOK_SECRET` | erzeugt `scripts/einrichten.sh` selbst |
| `ALLOWED_CHAT_ID` | aus `npx wrangler tail` nach der ersten Nachricht |
| `ANTHROPIC_API_KEY` | Anthropic-Konsole, Schlüssel `assistent-bot` (mit Ausgabenlimit) |
| `GITHUB_TOKEN` | Fine-grained Token von `alexmein`, nur Repo `Assistent`, Contents: Read and write |

## Befehle
```
npm test              # Tests
npm run typecheck
./scripts/einrichten.sh   # Deploy + Secrets + Webhook (einmalig)
npm run deploy        # spätere Deploys
npm run tail          # Live-Log
```
