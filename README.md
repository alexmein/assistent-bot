# assistent-bot

Telegram-Bot des persönlichen Assistenten. Läuft als Cloudflare Worker.
Regeln, Wissen und Bauplan stehen im Repo `alexmein/Assistent` (`CLAUDE.md`, `docs/bauplan.md`, Entscheidungen 38/39).

## Stand: Schritt 6 von 8 – Google: Dokumente → Drive, Termine → Kalender
- `POST /telegram` mit Telegram-Webhook-Secret; alles andere 404/401.
- Antwortet nur im privaten Chat mit `ALLOWED_CHAT_ID`; fremde Chats werden ignoriert (nur die ID wird geloggt, nie Text).
- `/status` liest `docs/status.md` über die GitHub-API (`GITHUB_REPO` in `wrangler.toml`). `/start` zeigt die Hilfe.
- Jeder andere Text geht an Claude Haiku 5.5 (`src/ask.ts`): CLAUDE.md (gecacht) + Dashboard + Eingangskorb im Systemprompt,
  Werkzeuge `read_file` (`CLAUDE.md`, `docs|bereiche|monitor|archiv/*.md`) und `append_entry` (`src/append.ts`).
  Höchstens 4 Modellaufrufe und 6 Werkzeugaufrufe pro Nachricht.
- `append_entry` hängt genau eine Zeile an einen erlaubten Abschnitt an (Bereiche: Aktiv/Wartet/Geparkt; Eingangskorb;
  Dashboard: Kritisch, Fristen, → am Mac). Der Code prüft vor jedem Schreiben, dass sich die Datei nur um diese Zeile
  ändert; erledigt markieren, `[A]`/`[A~]` und Nummern nach R7 werden abgelehnt. Jede Ablage ist ein Commit
  „… (via Telegram)“. Die Bestätigung „Abgelegt: …“ erzeugt der Code aus dem tatsächlich Gespeicherten.
- Dateien und Fotos (`src/google.ts`): `save_document` legt sie unter Drive `Assistent-Ablage/<Ordner>` ab (Scope
  `drive.file`: nur selbst angelegte Dateien), danach Verweis unter `## Verweise` im Bereich. PDFs bis 5 MB und Bilder
  bis 4,5 MB liest das Modell mit, größere nur nach Name und Begleittext.
- Termine: `create_event` nur bei Text von Alex, nie bei Dateien (CLAUDE.md §2); schreibt nur in den Hauptkalender. Verbrauch und Kosten je Frage stehen im Log (`Verbrauch {...}`), ohne Frage- oder Antworttext.

## Secrets (nur per `wrangler secret put`, nie im Repo)
| Name | Woher |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather; `scripts/einrichten.sh` fragt verdeckt ab |
| `TELEGRAM_WEBHOOK_SECRET` | erzeugt `scripts/einrichten.sh` selbst |
| `ALLOWED_CHAT_ID` | aus `npx wrangler tail` nach der ersten Nachricht |
| `ANTHROPIC_API_KEY` | Anthropic-Konsole, Schlüssel `assistent-bot` (mit Ausgabenlimit) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | `node scripts/google-auth.mjs` (fragt verdeckt ab, setzt alle drei und `DRIVE_ROOT_ID` in `wrangler.toml`) |
| `GITHUB_TOKEN` | Fine-grained Token von `alexmein`, nur Repo `Assistent`, Contents: Read and write |

## Befehle
```
npm test              # Tests
npm run typecheck
./scripts/einrichten.sh   # Deploy + Secrets + Webhook (einmalig)
npm run deploy        # spätere Deploys
npm run tail          # Live-Log
```
