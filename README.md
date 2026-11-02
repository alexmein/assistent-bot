# assistent-bot

Telegram-Bot des persönlichen Assistenten. Läuft als Cloudflare Worker.
Regeln, Wissen und Bauplan stehen im Repo `alexmein/Assistent` (`CLAUDE.md`, `docs/bauplan.md`, Entscheidungen 38/39).

## Stand: Schritt 7 von 8 – Mail-Eingang
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
- Mail-Eingang (`src/mail.ts`, Entscheidung 44): Cron alle 15 Minuten (höchstens 8 Mails), `/mail` sofort (höchstens 3).
  Ganzes Konto (`gmail.readonly`), 3 Tage zurück; erledigte IDs in KV `MAIL_SEEN`. Das Modell bekommt die Mail ohne
  Werkzeuge und liefert festes JSON (relevant, Kurzfassung, Bereich, To-dos, Ablage der Anhänge, Unklares,
  Einflussnahme); geschrieben wird nur vom Code („… (via Mail)“). Spam ans Hauptpostfach wird ohne Modell aussortiert,
  Spam an `MAIL_FORWARD_ADDRESS` bringt nur einen Prüfhinweis. Einflussnahme (Modell oder Code-Muster) → Auffälligkeit,
  aus der Mail wird nichts übernommen. Anhänge bis 5 MB (höchstens 3) → Drive mit Verweis. Meldung auf Telegram nur
  außerhalb der Ruhezeiten.
- Termine: `create_event` nur bei Text von Alex, nie bei Dateien (CLAUDE.md §2); schreibt nur in den Hauptkalender. Verbrauch und Kosten je Frage stehen im Log (`Verbrauch {...}`), ohne Frage- oder Antworttext.

## Secrets (nur per `wrangler secret put`, nie im Repo)
| Name | Woher |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather; `scripts/einrichten.sh` fragt verdeckt ab |
| `TELEGRAM_WEBHOOK_SECRET` | erzeugt `scripts/einrichten.sh` selbst |
| `ALLOWED_CHAT_ID` | aus `npx wrangler tail` nach der ersten Nachricht |
| `ANTHROPIC_API_KEY` | Anthropic-Konsole, Schlüssel `assistent-bot` (mit Ausgabenlimit) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | `node scripts/google-auth.mjs` (fragt verdeckt ab, setzt alle drei und `DRIVE_ROOT_ID` in `wrangler.toml`) |
| `MAIL_FORWARD_ADDRESS` | Plus-Adresse, an die iCloud weiterleitet (`…+assistent@…`) |
| `GITHUB_TOKEN` | Fine-grained Token von `alexmein`, nur Repo `Assistent`, Contents: Read and write |

## Befehle
```
npm test              # Tests
npm run typecheck
./scripts/einrichten.sh   # Deploy + Secrets + Webhook (einmalig)
npm run deploy        # spätere Deploys
npm run tail          # Live-Log
```
