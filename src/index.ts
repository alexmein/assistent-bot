// Assistent-Bot, Schritt 2: /status aus dem Repo, sonst Echo. Nimmt nur Nachrichten aus Alex' Chat an.

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_CHAT_ID?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number; type: string };
    text?: string;
  };
}

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

    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, await reply(message.text, env));
    return ok();
  },
};

const HELP = "Befehle: /status – Dashboard aus docs/status.md. Alles andere kommt vorerst als Echo zurück.";

async function reply(text: string | undefined, env: Env): Promise<string> {
  if (!text) return "In diesem Schritt verstehe ich nur Text.";
  // Telegram hängt in manchen Clients den Bot-Namen an: /status@meinwiedein_bot
  const command = text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
  if (command === "/start" || command === "/hilfe" || command === "/help") return HELP;
  if (command === "/status") return statusReply(env);
  return `Echo: ${text}`;
}

async function statusReply(env: Env): Promise<string> {
  if (!env.GITHUB_TOKEN) return "Für /status fehlt noch der GitHub-Zugang (GITHUB_TOKEN).";
  const result = await readRepoFile(env, "docs/status.md");
  if (!result.ok) return `Konnte docs/status.md nicht laden (${result.error}).`;
  return truncate(result.text, TELEGRAM_MAX);
}

type FileResult = { ok: true; text: string } | { ok: false; error: string };

async function readRepoFile(env: Env, path: string): Promise<FileResult> {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
    headers: {
      Accept: "application/vnd.github.raw+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "assistent-bot",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    console.log(`GitHub ${path}: HTTP ${res.status}`);
    return { ok: false, error: `GitHub HTTP ${res.status}` };
  }
  return { ok: true, text: await res.text() };
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
