import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

const env: Env = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_WEBHOOK_SECRET: "test-secret",
  ALLOWED_CHAT_ID: "111",
};

function update(chatId: number, text?: string, type = "private") {
  return { update_id: 1, message: { chat: { id: chatId, type }, text } };
}

function post(body: unknown, secret = "test-secret", path = "/telegram") {
  return new Request(`https://bot.example${path}`, {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": secret, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockTelegram() {
  const spy = vi.fn(async () => new Response('{"ok":true}'));
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe("Echo-Bot", () => {
  it("antwortet Alex mit einem Echo", async () => {
    const tg = mockTelegram();
    const res = await worker.fetch(post(update(111, "Hallo")), env);
    expect(res.status).toBe(200);
    expect(tg).toHaveBeenCalledOnce();
    const [url, init] = tg.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bottest-token/sendMessage");
    expect(JSON.parse(init.body as string)).toEqual({ chat_id: "111", text: "Echo: Hallo" });
  });

  it("ignoriert fremde Chats, quittiert aber mit 200", async () => {
    const tg = mockTelegram();
    const res = await worker.fetch(post(update(999, "Hallo")), env);
    expect(res.status).toBe(200);
    expect(tg).not.toHaveBeenCalled();
  });

  it("ignoriert Gruppen, auch mit Alex' ID", async () => {
    const tg = mockTelegram();
    await worker.fetch(post(update(111, "Hallo", "group")), env);
    expect(tg).not.toHaveBeenCalled();
  });

  it("antwortet niemandem, solange ALLOWED_CHAT_ID fehlt", async () => {
    const tg = mockTelegram();
    const res = await worker.fetch(post(update(111, "Hallo")), { ...env, ALLOWED_CHAT_ID: undefined });
    expect(res.status).toBe(200);
    expect(tg).not.toHaveBeenCalled();
  });

  it("lehnt falsches Webhook-Secret ab", async () => {
    const tg = mockTelegram();
    const res = await worker.fetch(post(update(111, "Hallo"), "falsch"), env);
    expect(res.status).toBe(401);
    expect(tg).not.toHaveBeenCalled();
  });

  it("lehnt ab, wenn kein Webhook-Secret konfiguriert ist", async () => {
    const res = await worker.fetch(post(update(111, "Hallo"), ""), { ...env, TELEGRAM_WEBHOOK_SECRET: "" });
    expect(res.status).toBe(401);
  });

  it("kennt nur POST /telegram", async () => {
    expect((await worker.fetch(post(update(111, "x"), "test-secret", "/"), env)).status).toBe(404);
    expect((await worker.fetch(new Request("https://bot.example/telegram"), env)).status).toBe(404);
  });

  it("weist Nicht-Text freundlich ab", async () => {
    const tg = mockTelegram();
    await worker.fetch(post(update(111)), env);
    const [, init] = tg.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).text).toBe("In diesem Schritt verstehe ich nur Text.");
  });
});
