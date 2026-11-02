// Assistent-Bot, Schritt 6: /status aus dem Repo; Text → Fragen, Erfassen, Termine; Dateien/Fotos → Drive.
// Nimmt nur Nachrichten aus Alex' Chat an.

import { ask, defaultDeps, type Attachment } from "./ask";
import type { Env } from "./env";
import { readRepoFile } from "./github";
import { googleReady } from "./google";

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
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, answer);
    return ok();
  },
};

const HELP =
  "Befehle: /status – Dashboard aus docs/status.md. Text lege ich ab, trage genannte Termine ein oder beantworte ihn als kleine Frage. Dateien und Fotos lege ich in Drive ab. Ändern, Erledigen und Löschen nur in der Triage am Mac.";

async function reply(text: string | undefined, env: Env, chatId: string): Promise<string> {
  if (!text) return "Ich verstehe Text, Dateien und Fotos.";
  // Telegram hängt in manchen Clients den Bot-Namen an: /status@meinwiedein_bot
  const command = text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
  if (command === "/start" || command === "/hilfe" || command === "/help") return HELP;
  if (command === "/status") return statusReply(env);
  if (command.startsWith("/")) return `Unbekannter Befehl. ${HELP}`;
  if (!env.GITHUB_TOKEN) return "Mir fehlt noch der GitHub-Zugang (GITHUB_TOKEN).";
  if (!env.ANTHROPIC_API_KEY) return "Für Fragen fehlt noch der Anthropic-Schlüssel (ANTHROPIC_API_KEY).";
  await sendChatAction(env.TELEGRAM_BOT_TOKEN, chatId);
  return truncate(await ask(text, defaultDeps(env, googleReady(env))), TELEGRAM_MAX);
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

async function sendMessage(token: string, chatId: string, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) console.log(`sendMessage fehlgeschlagen: HTTP ${res.status}`);
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
