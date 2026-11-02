// Assistent-Bot, Schritt 7: /status aus dem Repo; Text → Fragen, Erfassen, Termine; Dateien/Fotos → Drive;
// alle 15 Minuten Mail-Eingang (Cron). Nimmt nur Nachrichten aus Alex' Chat an.

import Anthropic from "@anthropic-ai/sdk";
import { appendEntry } from "./append";
import { ask, defaultDeps, type Attachment } from "./ask";
import type { Env } from "./env";
import { buildBriefing, fetchWeather } from "./briefing";
import { commitMessagesSince, readRepoFile, writeTriageFile } from "./github";
import { checkGoogle, downloadFile, getAttachment, getMessage, GoogleError, googleReady, listMessages, saveToDrive } from "./google";
import { GMAIL_QUERY, pollMail, type GmailMessage, type LoadedAttachment, type MailRun } from "./mail";
import { sendDue } from "./reminders";
import { critical, notice, prepareTriage, renderTriage, telegramLine, type Vorbereitung } from "./triage";
import { berlin, hm, parseHm, quietTime, runDue, type Job } from "./schedule";

export type { Env } from "./env";

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramMessage {
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  photo?: { file_id: string; file_size?: number }[];
}

const TELEGRAM_FILE_MAX = 20 * 1024 * 1024; // Bot-API lädt höchstens 20 MB herunter

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/telegram") {
      return new Response("Not found", { status: 404 });
    }

    const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (!env.TELEGRAM_WEBHOOK_SECRET || !safeEqual(header, env.TELEGRAM_WEBHOOK_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }

    let update: TelegramUpdate;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    // Ab hier immer 200, sonst stellt Telegram dieselbe Nachricht erneut zu.
    const message = update.message;
    if (!message) return ok();

    const chatId = String(message.chat.id);
    if (!env.ALLOWED_CHAT_ID || chatId !== env.ALLOWED_CHAT_ID || message.chat.type !== "private") {
      // Nur die ID loggen, nie den Nachrichtentext (R7). So findet Alex beim Einrichten seine Chat-ID.
      console.log(`Abgelehnt: chat_id=${chatId} typ=${message.chat.type}`);
      return ok();
    }

    const answer = message.document || message.photo ? await fileReply(message, env, chatId) : await reply(message.text, env, chatId);
    if (answer) await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, answer); // leer = Datei geschickt, nichts zu sagen
    return ok();
  },

  // Cron alle 5 Minuten: Erinnerungen und geplante Läufe (Berliner Zeit); Mail-Eingang nur jede Viertelstunde.
  // Meldung zum Mail-Eingang auf Telegram nur außerhalb der Ruhezeiten; abgelegt wird immer.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const now = new Date(controller.scheduledTime);
    if (env.STATE && env.ALLOWED_CHAT_ID) {
      await sendDue(env.STATE, now, (text) => sendMessageOrThrow(env.TELEGRAM_BOT_TOKEN, env.ALLOWED_CHAT_ID!, text));
      await runDue(jobs(env), now, env.STATE);
      if (env.ANTHROPIC_API_KEY && env.GITHUB_TOKEN) await requestedTriage(env);
    } else console.log("Zeitpläne aus: KV STATE oder ALLOWED_CHAT_ID fehlt");
    if (now.getUTCMinutes() % 15 !== 0) return;
    const reason = mailNotReady(env);
    if (reason) return console.log(`Mail-Eingang aus: ${reason}`);
    const run = await runMail(env, 8);
    if (run.report.length && env.ALLOWED_CHAT_ID && !quietTime(new Date())) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, env.ALLOWED_CHAT_ID, truncate(mailText(run), TELEGRAM_MAX));
    }
  },
};

function jobs(env: Env): Job[] {
  const list: Job[] = [];
  if (env.ALLOWED_CHAT_ID && env.GITHUB_TOKEN && env.STATE) {
    // Dienstags kommt bis Schritt 5 (Wochenbriefing) ebenfalls das Tagesbriefing.
    list.push({
      name: "tagesbriefing",
      at: (day) => (day === "Sat" || day === "Sun" ? hm(10, 30) : hm(8, 30)),
      run: async () => {
        const started = new Date().toISOString();
        const text = await briefing(env, (await env.STATE!.get(LAST_BRIEFING)) ?? hoursAgo(24));
        await sendMessageOrThrow(env.TELEGRAM_BOT_TOKEN, env.ALLOWED_CHAT_ID!, truncate(text, TELEGRAM_MAX));
        await env.STATE!.put(LAST_BRIEFING, started); // erst nach dem Versand: sonst fehlt Neues im nächsten Briefing
      },
    });
  }
  if (env.ALLOWED_CHAT_ID && env.GITHUB_TOKEN && env.ANTHROPIC_API_KEY && env.STATE) {
    list.push({
      name: "triage",
      at: (day) => (day === "Sat" || day === "Sun" ? null : hm(8, 45)),
      run: async () => {
        const previous = Number((await env.STATE!.get(TRIAGE_CRITICAL)) ?? 0);
        const { v, path } = await triage(env);
        const text = notice(v, berlin(new Date()).weekday, previous);
        if (text) await sendMessageOrThrow(env.TELEGRAM_BOT_TOKEN, env.ALLOWED_CHAT_ID!, `${text} (${path})`);
      },
    });
  }
  const probe = parseHm(env.PROBE_AT);
  if (probe !== null && env.ALLOWED_CHAT_ID) {
    // Ausdrücklich terminiert wie eine Erinnerung → geht auch in der Ruhezeit durch.
    list.push({
      name: "probe",
      at: () => probe,
      ignoresQuiet: true,
      run: () => sendMessageOrThrow(env.TELEGRAM_BOT_TOKEN, env.ALLOWED_CHAT_ID!, `Probe Zeitgerüst: geplant ${env.PROBE_AT} Berliner Zeit.`),
    });
  }
  return list;
}

const LAST_BRIEFING = "briefing:last";
const TRIAGE_REQUESTED = "triage:requested";
const TRIAGE_CRITICAL = "triage:critical"; // fristkritische Punkte der letzten Vorbereitung

async function requestedTriage(env: Env): Promise<void> {
  if (!(await env.STATE!.get(TRIAGE_REQUESTED))) return;
  await env.STATE!.delete(TRIAGE_REQUESTED); // vorher löschen: lieber einmal neu anfordern als doppelt laufen
  let text: string;
  try {
    const { v, path } = await triage(env);
    text = `${telegramLine(v)} (${path})`;
  } catch (e) {
    text = `Triage-Vorbereitung fehlgeschlagen: ${e instanceof Error ? e.message : "Fehler"}`;
  }
  await sendMessage(env.TELEGRAM_BOT_TOKEN, env.ALLOWED_CHAT_ID!, text);
}

// Bereitet die Triage vor und schreibt triage/JJJJ-MM-TT.md (Commit „via Briefing“). Die Commits der letzten 14 Tage
// zeigen dem Modell, was neu ist; die Dateien selbst enthalten den ganzen offenen Stand.
async function triage(env: Env): Promise<{ v: Vorbereitung; path: string }> {
  const started = new Date();
  const since = new Date(started.getTime() - 14 * 86_400_000).toISOString();
  const v = await prepareTriage(
    {
      readFile: (path) => readRepoFile(env, path),
      commitsSince: (iso) => commitMessagesSince(env, iso),
      client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 120_000 }),
      now: () => started,
    },
    since,
  );
  const date = started.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  const path = `triage/${date}.md`;
  await writeTriageFile(env, path, renderTriage(v, date), `${path}: Vorbereitung (via Briefing)`);
  await env.STATE!.put(TRIAGE_CRITICAL, String(critical(v)));
  return { v, path };
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

function briefing(env: Env, sinceIso: string): Promise<string> {
  return buildBriefing(
    {
      readFile: (path) => readRepoFile(env, path),
      commitsSince: (iso) => commitMessagesSince(env, iso),
      weather: () => fetchWeather(),
      now: () => new Date(),
    },
    sinceIso,
  );
}

function mailNotReady(env: Env): string | null {
  if (!googleReady(env)) return "Google nicht eingerichtet";
  if (!env.MAIL_FORWARD_ADDRESS) return "MAIL_FORWARD_ADDRESS fehlt";
  if (!env.MAIL_SEEN) return "KV MAIL_SEEN fehlt";
  if (!env.GITHUB_TOKEN || !env.ANTHROPIC_API_KEY) return "GITHUB_TOKEN/ANTHROPIC_API_KEY fehlt";
  return null;
}

function runMail(env: Env, max: number): Promise<MailRun> {
  const deps = {
    list: () => listMessages(env, GMAIL_QUERY),
    get: (id: string) => getMessage<GmailMessage>(env, id),
    attachment: (messageId: string, attachmentId: string) => getAttachment(env, messageId, attachmentId),
    save: (folder: string[], name: string, f: LoadedAttachment) => saveToDrive(env, folder, name, f.mime, f.bytes),
    forwardAddress: env.MAIL_FORWARD_ADDRESS!,
    seen: env.MAIL_SEEN!,
    client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 45_000 }),
    write: (path: string, section: string, line: string) => appendEntry(env, path, section, line, "Mail"),
    now: () => new Date(),
  };
  return pollMail(deps, max);
}

// Nur Zählwerte, nie Inhalte: zeigt, ob die Mails im Konto liegen und welcher Filter sie findet.
async function mailDiagnosis(env: Env): Promise<string> {
  const addr = env.MAIL_FORWARD_ADDRESS!;
  const queries: [string, string][] = [
    ["Filter (ganzes Konto, 3 Tage)", GMAIL_QUERY],
    ["davon an +assistent", `${GMAIL_QUERY} deliveredto:${addr}`],
    ["davon Spam", `${GMAIL_QUERY} in:spam`],
  ];
  const lines = [`Weiterleitungsadresse: ${addr}`];
  for (const [label, q] of queries) {
    try {
      lines.push(`${label}: ${(await listMessages(env, q)).length}`);
    } catch (e) {
      lines.push(`${label}: Fehler ${e instanceof Error ? e.message : ""}`);
    }
  }
  return lines.join("\n");
}

function mailText(run: MailRun): string {
  const ignored = run.ignored ? `\n(${run.ignored} ohne Ablage: Werbung, Systemmails, Spam)` : "";
  return [`Mail-Eingang (${run.report.length}):`, ...run.report.map((r) => `- ${r}`)].join("\n") + ignored;
}

const HELP =
  "Befehle: /status – Dashboard aus docs/status.md. /check – Google-Zugriff prüfen. „Schick mir …“ – Datei aus der Drive-Ablage in diesen Chat. /briefing – Tagesbriefing jetzt (Vorschau). „Erinnere mich …“ – Push zur genannten Zeit. /triage – Triage jetzt vorbereiten (sonst Montag 8:45). /mail – Mail-Eingang jetzt abrufen (sonst alle 15 Minuten). Text lege ich ab, trage genannte Termine ein oder beantworte ihn als kleine Frage. Dateien und Fotos lege ich in Drive ab. Ändern, Erledigen und Löschen nur in der Triage am Mac.";

async function reply(text: string | undefined, env: Env, chatId: string): Promise<string> {
  if (!text) return "Ich verstehe Text, Dateien und Fotos.";
  // Telegram hängt in manchen Clients den Bot-Namen an: /status@meinwiedein_bot
  const command = text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
  if (command === "/start" || command === "/hilfe" || command === "/help") return HELP;
  if (command === "/status") return statusReply(env);
  if (command === "/check") return googleReady(env) ? (await checkGoogle(env)).join("\n") : "Google ist noch nicht eingerichtet.";
  if (command === "/briefing") {
    // Vorschau: zählt nicht als Briefing, das nächste geplante bringt dieselben Neuigkeiten noch einmal.
    await sendChatAction(env.TELEGRAM_BOT_TOKEN, chatId);
    const since = (await env.STATE?.get(LAST_BRIEFING)) ?? hoursAgo(24);
    try {
      return truncate(await briefing(env, since), TELEGRAM_MAX);
    } catch (e) {
      return `Briefing fehlgeschlagen: ${e instanceof Error ? e.message : "Fehler"}`;
    }
  }
  if (command === "/triage") {
    // Vorbereitung jetzt (z. B. vor einer Triage außer der Reihe); schreibt die Datei für heute.
    // Läuft im nächsten Cron (bis 5 Min.): Sonnet braucht womöglich länger, als Telegram auf die Antwort wartet.
    if (!env.ANTHROPIC_API_KEY || !env.STATE) return "Für die Triage fehlen Zugänge (ANTHROPIC_API_KEY / STATE).";
    await env.STATE.put(TRIAGE_REQUESTED, "1", { expirationTtl: 3600 });
    return "Triage wird vorbereitet – Meldung in den nächsten Minuten.";
  }
  if (command === "/mail") {
    const reason = mailNotReady(env);
    if (reason) return `Mail-Eingang noch nicht bereit: ${reason}.`;
    await sendChatAction(env.TELEGRAM_BOT_TOKEN, chatId);
    try {
      // Höchstens 3 pro Aufruf, damit Telegram nicht auf die Antwort wartet und neu zustellt; den Rest holt der Cron.
      const run = await runMail(env, 3);
      if (run.report.length) return mailText(run);
      return run.ignored ? mailText(run) : `Keine neuen Mails.\n${await mailDiagnosis(env)}`;
    } catch (e) {
      return `Mail-Abruf fehlgeschlagen: ${e instanceof Error ? e.message : "Fehler"}`;
    }
  }
  if (command.startsWith("/")) return `Unbekannter Befehl. ${HELP}`;
  if (!env.GITHUB_TOKEN) return "Mir fehlt noch der GitHub-Zugang (GITHUB_TOKEN).";
  if (!env.ANTHROPIC_API_KEY) return "Für Fragen fehlt noch der Anthropic-Schlüssel (ANTHROPIC_API_KEY).";
  await sendChatAction(env.TELEGRAM_BOT_TOKEN, chatId);
  // Dateien gehen nur in diesen Chat (Entscheidung 45) – der Empfänger steht im Code, nicht beim Modell.
  const sendFile = async (id: string) => {
    const file = await downloadFile(env, id);
    await sendDocument(env.TELEGRAM_BOT_TOKEN, chatId, file.name, file.mime, file.bytes);
    return file.name;
  };
  return truncate(await ask(text, defaultDeps(env, googleReady(env), sendFile)), TELEGRAM_MAX);
}

async function fileReply(message: TelegramMessage, env: Env, chatId: string): Promise<string> {
  if (!googleReady(env)) return "Für Dateien fehlt noch die Google-Anbindung.";
  if (!env.GITHUB_TOKEN || !env.ANTHROPIC_API_KEY) return "Mir fehlen noch Zugänge (GITHUB_TOKEN / ANTHROPIC_API_KEY).";
  const doc = message.document;
  const photo = message.photo?.at(-1); // größte Auflösung
  const fileId = doc?.file_id ?? photo!.file_id;
  const size = doc?.file_size ?? photo?.file_size ?? 0;
  if (size > TELEGRAM_FILE_MAX) return "Die Datei ist zu groß (Telegram erlaubt Bots höchstens 20 MB). Bitte direkt in Drive ablegen.";

  await sendChatAction(env.TELEGRAM_BOT_TOKEN, chatId);
  const bytes = await downloadTelegramFile(env.TELEGRAM_BOT_TOKEN, fileId);
  if (!bytes) return "Konnte die Datei nicht von Telegram laden. Bitte noch einmal schicken.";
  const attachment: Attachment = {
    fileName: doc?.file_name ?? "Foto.jpg",
    mime: doc?.mime_type ?? "image/jpeg",
    bytes,
    caption: message.caption,
  };
  return truncate(await ask("", defaultDeps(env, true), attachment), TELEGRAM_MAX);
}

async function downloadTelegramFile(token: string, fileId: string): Promise<Uint8Array | null> {
  const info = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!info.ok) return null;
  const path = ((await info.json()) as { result?: { file_path?: string } }).result?.file_path;
  if (!path) return null;
  const file = await fetch(`https://api.telegram.org/file/bot${token}/${path}`);
  return file.ok ? new Uint8Array(await file.arrayBuffer()) : null;
}

async function statusReply(env: Env): Promise<string> {
  if (!env.GITHUB_TOKEN) return "Für /status fehlt noch der GitHub-Zugang (GITHUB_TOKEN).";
  const result = await readRepoFile(env, "docs/status.md");
  if (!result.ok) return `Konnte docs/status.md nicht laden (${result.error}).`;
  return truncate(result.text, TELEGRAM_MAX);
}

const TELEGRAM_MAX = 4096;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const note = "\n… (gekürzt, vollständig am Mac)";
  return text.slice(0, max - note.length) + note;
}

function ok(): Response {
  return new Response("OK");
}

// Für geplante Läufe: Fehler werfen, damit der Lauf nicht als erledigt gilt und der nächste Cron es erneut versucht.
async function sendMessageOrThrow(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
}

async function sendMessage(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) console.log(`sendMessage fehlgeschlagen: HTTP ${res.status}`);
}

async function sendDocument(token: string, chatId: string, name: string, mime: string, bytes: Uint8Array): Promise<void> {
  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("document", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), name);
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form });
  // GoogleError, damit ask() den Fehler als Werkzeugfehler meldet statt abzubrechen.
  if (!res.ok) throw new GoogleError(`Telegram hat die Datei nicht angenommen (HTTP ${res.status}).`);
}

// „schreibt …“ in Telegram, solange das Modell arbeitet.
async function sendChatAction(token: string, chatId: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  });
}

// Vergleich ohne frühen Abbruch, damit die Laufzeit das Secret nicht verrät.
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}
