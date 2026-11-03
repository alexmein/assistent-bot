# assistent-bot

Telegram-Bot des persönlichen Assistenten. Läuft als Cloudflare Worker.
Regeln, Wissen und Bauplan stehen im Repo `alexmein/Assistent` (`CLAUDE.md`, `docs/bauplan.md`, Entscheidungen 38/39).

## Stand: Phase 2 abgeschlossen (Schritte 1–9), Phase 3 gebaut (Abschluss nach der ersten echten Woche)
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
  aus der Mail wird nichts übernommen. Anhänge bis 5 MB (höchstens 3) → Drive mit Verweis. Abgelegt wird still; auf
  Telegram nur kritische To-dos mit Frist bis übermorgen, außerhalb der Ruhezeiten (Entscheidung 57). `/mail` zeigt alles.
- `/check` prüft Google nur lesend und zeigt die erteilten Rechte (Mail senden muss „nein“ sein).
- Dateien auf Anfrage (`find_file`/`send_file`, Entscheidung 45): nur aus der Drive-Ablage, nur in Alex' Chat.

### Phase 3 – Zeitpläne (`src/schedule.ts`, Cron alle 5 Minuten, Berliner Zeit, Ruhezeiten, jeder Lauf einmal)
| Wann | Was | Datei |
|---|---|---|
| alle 5 Min. | fällige Push-Erinnerungen (KV `STATE`, auch in Ruhezeiten) | `src/reminders.ts` |
| alle 15 Min. | Mail-Eingang | `src/mail.ts` |
| tägl. 8:30, Sa/So 10:30 (nicht Di) | Tagesbriefing, ohne Modell; Sa/So nur, wenn etwas fällig ist | `src/briefing.ts`, `src/kalender.ts` |
| Di 7:30 / 8:30 | Umfeld-Recherche (Haiku + Websuche) / Wochenbriefing | `src/umfeld.ts`, `src/briefing.ts` |
| Mo 8:15 | Meta-Prüfung, Cloud-Teil (Sonnet 5.5, GitHub lesend) | `src/meta.ts` |
| Mo–Fr 8:45 | Triage-Vorbereitung → `triage/JJJJ-MM-TT.md` (Sonnet 5.5); Telegram nur Do, wenn > 1 Runde offen | `src/triage.ts` |

Telegram-Verschlankung (Entscheidung 57): Briefing nennt Fristen der Woche nur kritisch/dringend, Neues nur als
höchstens 3 To-dos plus Zahl, Ferien/Umfeld nur heute/morgen; Wochenbriefing ohne Selbstkontrolle und Meta-Prüfung.

Befehle: `/briefing`, `/woche` (Vorschauen), `/triage`, `/umfeld`, `/meta` (laufen im nächsten Cron), `/mail`.
Ganze Dateien schreibt der Bot nur unter `triage/` (`writeTriageFile`); sonst nur Anhängen.
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
| `HC_GITHUB_TOKEN` | Fine-grained Token, Owner `hungry-collective`, nur hc-system/-kitchen/-orders/-shopify, Contents: Read-only |
| `GITHUB_TOKEN` | Fine-grained Token von `alexmein`, nur Repo `Assistent`, Contents: Read and write |

## Befehle
```
npm test              # Tests
npm run typecheck
./scripts/einrichten.sh   # Deploy + Secrets + Webhook (einmalig)
npm run deploy        # spätere Deploys
npm run tail          # Live-Log
```
