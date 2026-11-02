// Assistent-Bot, Schritt 1: Echo. Nimmt nur Nachrichten aus Alex' Chat an.

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_CHAT_ID?: string;
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

    const reply = message.text ? `Echo: ${message.text}` : "In diesem Schritt verstehe ich nur Text.";
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, reply);
    return ok();
  },
};

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
