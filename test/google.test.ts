import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { checkEvent, checkFileName, checkFolder, checkGoogle, saveToDrive } from "../src/google";

describe("checkFolder", () => {
  it("akzeptiert 1–3 Ebenen", () => {
    expect(checkFolder("Steuern/2025")).toEqual(["Steuern", "2025"]);
    expect(checkFolder(" Wohnung Ackerstraße ")).toEqual(["Wohnung Ackerstraße"]);
  });
  it.each(["", "a/b/c/d", "../x", "Steuern/..", "/", "x'y", ".versteckt"])("lehnt %j ab", (f) => {
    expect(checkFolder(f)).toBeNull();
  });
});

describe("checkFileName", () => {
  it("hängt die Endung an", () => {
    expect(checkFileName("2026-10-28 Finanzamt Mahnung", "scan.PDF")).toBe("2026-10-28 Finanzamt Mahnung.PDF");
    expect(checkFileName("Brief.pdf", "x.pdf")).toBe("Brief.pdf");
  });
  it.each(["a/b", "x:y", ".env", "ab", "a\nb"])("lehnt %j ab", (n) => {
    expect(checkFileName(n, "x.pdf")).toBeNull();
  });
});

describe("checkEvent", () => {
  const today = "2026-11-02";
  it("Termin mit Uhrzeit, Standarddauer eine Stunde", () => {
    const r = checkEvent({ title: "Zahnarzt", date: "2026-11-05", start: "10:30" }, today);
    expect(r).toEqual({
      ok: true,
      body: { summary: "Zahnarzt", location: undefined, start: { dateTime: "2026-11-05T10:30:00", timeZone: "Europe/Berlin" }, end: { dateTime: "2026-11-05T11:30:00", timeZone: "Europe/Berlin" } },
      label: "Zahnarzt, 2026-11-05 10:30–11:30",
    });
  });
  it("ganztägig ohne Uhrzeit, Ende am Folgetag (auch über Monatsende)", () => {
    const r = checkEvent({ title: "Umzug", date: "2026-11-30" }, today);
    expect(r.ok && r.body.end).toEqual({ date: "2026-12-01" });
  });
  it("23-Uhr-Termin endet 23:59", () => {
    const r = checkEvent({ title: "Spät", date: "2026-11-05", start: "23:15" }, today);
    expect(r.ok && r.label).toBe("Spät, 2026-11-05 23:15–23:59");
  });
  it.each([
    [{ title: "x", date: "2026-11-05" }, "Titel"],
    [{ title: "Arzt", date: "5.11.2026" }, "Datum"],
    [{ title: "Arzt", date: "2026-11-01" }, "Vergangenheit"],
    [{ title: "Arzt", date: "2026-11-05", start: "25:00" }, "Beginn"],
    [{ title: "Arzt", date: "2026-11-05", start: "10:00", end: "09:00" }, "Ende"],
    [{ title: "Arzt", date: "2026-11-05", end: "11:00" }, "Ende"],
  ])("lehnt %j ab", (e, msg) => {
    const r = checkEvent(e, today);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(msg);
  });
});

describe("saveToDrive", () => {
  afterEach(() => vi.unstubAllGlobals());
  const env = { GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r", DRIVE_ROOT_ID: "root" } as Env;

  it("legt fehlende Ordner an und lädt in den richtigen Ordner hoch", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("oauth2")) return Response.json({ access_token: "at", expires_in: 3600 });
      if (url.includes("q=")) return Response.json({ files: url.includes("Steuern") ? [{ id: "steuern" }] : [] });
      if (url.includes("upload")) return Response.json({ id: "f", webViewLink: "https://drive/f" });
      return Response.json({ id: "neu2025" }); // Ordner angelegt
    }));
    const saved = await saveToDrive(env, ["Steuern", "2025"], "Brief.pdf", "application/pdf", new Uint8Array([37, 80, 68, 70]));
    expect(saved).toEqual({ name: "Brief.pdf", folder: "Steuern/2025", link: "https://drive/f" });
    const create = calls.find((c) => c.init?.method === "POST" && c.url.endsWith("files?fields=id"))!;
    expect(JSON.parse(create.init!.body as string)).toEqual({ name: "2025", mimeType: "application/vnd.google-apps.folder", parents: ["steuern"] });
    const upload = calls.find((c) => c.url.includes("upload"))!;
    const body = new TextDecoder().decode(upload.init!.body as Uint8Array);
    expect(body).toContain('{"name":"Brief.pdf","parents":["neu2025"]}');
    expect(body).toContain("%PDF");
    expect((upload.init!.headers as Record<string, string>).Authorization).toBe("Bearer at");
  });
});

describe("checkGoogle", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("große Dateien (> 5 MB) per resumable upload", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("oauth2")) return Response.json({ access_token: "at", expires_in: 3600 });
      if (url.includes("q=")) return Response.json({ files: [{ id: "eingang" }] });
      if (url.includes("uploadType=resumable")) return new Response(null, { headers: { Location: "https://upload.example/session1" } });
      if (url === "https://upload.example/session1") return Response.json({ id: "f", webViewLink: "https://drive/gross" });
      return new Response("unerwartet", { status: 500 });
    }));
    const bytes = new Uint8Array(6 * 1024 * 1024);
    const env = { GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r", DRIVE_ROOT_ID: "root" } as Env;
    const saved = await saveToDrive(env, ["Eingang"], "Vertrag.pdf", "application/pdf", bytes);
    expect(saved.link).toBe("https://drive/gross");
    const put = calls.find((c) => c.init?.method === "PUT")!;
    expect(put.init!.body).toBe(bytes);
    expect((put.init!.headers as Record<string, string>).Authorization).toBe("Bearer at");
    const start = calls.find((c) => c.url.includes("uploadType=resumable"))!;
    expect(JSON.parse(start.init!.body as string)).toEqual({ name: "Vertrag.pdf", parents: ["eingang"] });
  });

  it("meldet je Dienst ok oder den Grund von Google, nur mit GET", async () => {
    const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "at2", expires_in: 3600 });
      methods.push(init?.method ?? "GET");
      if (url.includes("calendar")) return Response.json({ error: { errors: [{ reason: "accessNotConfigured" }] } }, { status: 403 });
      return Response.json({});
    }));
    const env = { GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r", DRIVE_ROOT_ID: "root" } as Env;
    expect(await checkGoogle(env)).toEqual(["Anmeldung: ok", "Kalender HTTP 403 (accessNotConfigured)", "Drive-Ablage: ok", "Gmail (lesen): ok"]);
    expect(methods).toEqual(["GET", "GET", "GET"]);
  });
});
