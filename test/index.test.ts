import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

const env: Env = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_WEBHOOK_SECRET: "test-secret",
  ALLOWED_CHAT_ID: "111",
  GITHUB_TOKEN: "gh-token",
  GITHUB_REPO: "alexmein/Assistent",
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

function mockTelegram(github: () => Response = () => new Response("# Dashboard")) {
  const spy = vi.fn(async (url: string) =>
    url.startsWith("https://api.github.com/") ? github() : new Response('{"ok":true}'),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

function sentText(spy: ReturnType<typeof mockTelegram>): string {
  const call = spy.mock.calls.find(([url]) => String(url).includes("api.telegram.org"));
  return JSON.parse((call as unknown as [string, RequestInit])[1].body as string).text;
}

afterEach(() => vi.unstubAllGlobals());

describe("Zugang", () => {
  it("antwortet Alex (ohne Anthropic-Schlüssel mit Hinweis)", async () => {
    const tg = mockTelegram();
    const res = await worker.fetch(post(update(111, "Hallo")), env);
    expect(res.status).toBe(200);
    expect(tg).toHaveBeenCalledOnce();
    const [url, init] = tg.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bottest-token/sendMessage");
    expect(JSON.parse(init.body as string)).toEqual({ chat_id: "111", text: "Für Fragen fehlt noch der Anthropic-Schlüssel (ANTHROPIC_API_KEY)." });
  });

  it("kennt keine anderen Befehle", async () => {
    const tg = mockTelegram();
    await worker.fetch(post(update(111, "/loeschen")), env);
    expect(sentText(tg)).toMatch(/^Unbekannter Befehl/);
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

describe("/status", () => {
  it("schickt docs/status.md aus dem Repo", async () => {
    const tg = mockTelegram();
    await worker.fetch(post(update(111, "/status")), env);
    const [url, init] = tg.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/alexmein/Assistent/contents/docs/status.md");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gh-token");
    expect(sentText(tg)).toBe("# Dashboard");
  });

  it("versteht /status@botname", async () => {
    const tg = mockTelegram();
    await worker.fetch(post(update(111, "/status@meinwiedein_bot")), env);
    expect(sentText(tg)).toBe("# Dashboard");
  });

  it("meldet GitHub-Fehler, ohne das Token zu verraten", async () => {
    const tg = mockTelegram(() => new Response("Bad credentials", { status: 401 }));
    await worker.fetch(post(update(111, "/status")), env);
    const text = sentText(tg);
    expect(text).toBe("Konnte docs/status.md nicht laden (GitHub HTTP 401).");
    expect(text).not.toContain("gh-token");
  });

  it("sagt Bescheid, wenn GITHUB_TOKEN fehlt", async () => {
    const tg = mockTelegram();
    await worker.fetch(post(update(111, "/status")), { ...env, GITHUB_TOKEN: undefined });
    expect(sentText(tg)).toContain("GITHUB_TOKEN");
    expect(tg.mock.calls.some(([url]) => String(url).includes("api.github.com"))).toBe(false);
  });

  it("kürzt auf Telegrams Grenze von 4096 Zeichen", async () => {
    const tg = mockTelegram(() => new Response("x".repeat(5000)));
    await worker.fetch(post(update(111, "/status")), env);
    const text = sentText(tg);
    expect(text.length).toBe(4096);
    expect(text.endsWith("(gekürzt, vollständig am Mac)")).toBe(true);
  });

  it("fremde Chats lösen keinen GitHub-Zugriff aus", async () => {
    const tg = mockTelegram();
    await worker.fetch(post(update(999, "/status")), env);
    expect(tg).not.toHaveBeenCalled();
  });

  it("/start zeigt die Hilfe", async () => {
    const tg = mockTelegram();
    await worker.fetch(post(update(111, "/start")), env);
    expect(sentText(tg)).toContain("/status");
  });
});
