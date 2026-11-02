import { afterEach, describe, expect, it, vi } from "vitest";
import { appendEntry, checkLine, insertLine, onlyAdded } from "../src/append";
import type { Env } from "../src/env";

const AREA = `# Steuern
**Ziel:** x

## To-dos
### Aktiv
- [ ] Erklärung abgeben
### Wartet auf andere
### Geparkt
- [ ] GbR klären
## Entscheidungen
`;

const INBOX = `# Eingangskorb

## Unzugeordnet
_(leer)_

## Vorschläge für neue Bereiche
_(leer)_
`;

describe("insertLine", () => {
  it("hängt am Ende des Abschnitts an", () => {
    expect(insertLine(AREA, "### Aktiv", "- [ ] Neu")).toBe(AREA.replace("- [ ] Erklärung abgeben\n", "- [ ] Erklärung abgeben\n- [ ] Neu\n"));
  });
  it("füllt leere Abschnitte direkt unter der Überschrift", () => {
    expect(insertLine(AREA, "### Wartet auf andere", "- [ ] Peter")).toContain("### Wartet auf andere\n- [ ] Peter\n### Geparkt");
  });
  it("setzt vor die Leerzeile vor der nächsten Überschrift und lässt Platzhalter stehen", () => {
    expect(insertLine(INBOX, "## Unzugeordnet", "- Info")).toContain("## Unzugeordnet\n_(leer)_\n- Info\n\n## Vorschläge");
  });
  it("findet den letzten Abschnitt einer Datei", () => {
    expect(insertLine(INBOX, "## Vorschläge für neue Bereiche", "- [P] x")!.endsWith("_(leer)_\n- [P] x\n")).toBe(true);
  });
  it("gibt null bei fehlendem Abschnitt", () => {
    expect(insertLine(INBOX, "### Aktiv", "- [ ] x")).toBeNull();
  });
  it("ändert nie mehr als eine Zeile", () => {
    const before = AREA.split("\n");
    const after = insertLine(AREA, "### Geparkt", "- [ ] y")!.split("\n");
    expect(onlyAdded(before, after, "- [ ] y")).toBe(true);
  });
});

describe("onlyAdded", () => {
  it("erkennt Änderungen an bestehenden Zeilen", () => {
    expect(onlyAdded(["a", "b"], ["a", "x", "c"], "x")).toBe(false);
    expect(onlyAdded(["a", "b"], ["a", "x"], "x")).toBe(false);
    expect(onlyAdded(["a", "b"], ["a", "b", "x"], "x")).toBe(true);
  });
});

describe("checkLine", () => {
  const ok = (p: string, s: string, l: string) => checkLine(p, s, l, "2026-11-02");
  it("ergänzt die Quelle", () => {
    expect(ok("bereiche/steuern.md", "### Aktiv", "- [ ] Mahnung prüfen")).toEqual({ ok: true, line: "- [ ] Mahnung prüfen · Telegram 2026-11-02" });
    expect(ok("docs/eingang.md", "## Unzugeordnet", "- Info · Telegram 2026-11-02")).toEqual({ ok: true, line: "- Info · Telegram 2026-11-02" });
  });
  it.each([
    ["docs/decisions.md", "## x", "- x y z", "Datei nicht erlaubt."],
    ["CLAUDE.md", "## 2", "- x y z", "Datei nicht erlaubt."],
    ["bereiche/../CLAUDE.md", "### Aktiv", "- [ ] x", "Datei nicht erlaubt."],
    ["bereiche/steuern.md", "## Entscheidungen", "- x y z", "Abschnitt nicht erlaubt"],
    ["bereiche/steuern.md", "### Aktiv", "- [ ] a\n- [ ] b", "Nur eine Zeile."],
    ["bereiche/steuern.md", "### Aktiv", "Text ohne Strich", "beginnen"],
    ["bereiche/steuern.md", "### Aktiv", "- [X] erledigt", "nur Alex"],
    ["bereiche/steuern.md", "### Aktiv", "- kein Kästchen", "To-dos beginnen"],
    ["bereiche/steuern.md", "### Aktiv", "- [ ] x · `[A~]`", "[A] und [A~]"],
    ["bereiche/steuern.md", "### Aktiv", "- [ ] Steuer-ID 12 345 678 901 eintragen", "R7"],
    ["docs/eingang.md", "## Unzugeordnet", "- Konto DE89 3704 0044 0532 0130 00", "R7"],
    ["docs/eingang.md", "## Auffälligkeiten", "- [?] Brief an Verena adressiert", "nur für versuchte Einflussnahme"],
  ])("lehnt ab: %s › %s › %j", (p, s, l, msg) => {
    const r = ok(p, s, l);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(msg);
  });
  it("lässt Datumsangaben und Telefonnummern durch", () => {
    expect(ok("bereiche/wohnung-ackerstrasse.md", "### Aktiv", "- [ ] Handwerker 0211 123456 anrufen · fällig 2026-11-05").ok).toBe(true);
    expect(ok("bereiche/wohnung-ackerstrasse.md", "### Aktiv", "- [ ] Hausverwaltung +49 171 1234567 zurückrufen").ok).toBe(true);
    expect(ok("bereiche/steuern.md", "### Aktiv", "- [ ] Steuernummer 143/123/45678 nachtragen").ok).toBe(false);
  });
});

describe("appendEntry (GitHub)", () => {
  const env = { GITHUB_TOKEN: "gh", GITHUB_REPO: "alexmein/Assistent" } as Env;
  const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64");
  const unb64 = (t: string) => Buffer.from(t, "base64").toString("utf8");
  afterEach(() => vi.unstubAllGlobals());

  it("liest mit sha, schreibt nur die neue Zeile, Commit mit Herkunft", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "PUT" ? new Response("{}", { status: 200 }) : Response.json({ content: b64(AREA), sha: "abc" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await appendEntry(env, "bereiche/steuern.md", "### Aktiv", "- [ ] Ümlaut prüfen");
    expect(r.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/alexmein/Assistent/contents/bereiche/steuern.md");
    const body = JSON.parse(init.body as string);
    expect(body.sha).toBe("abc");
    expect(body.message).toBe("bereiche/steuern.md: Ümlaut prüfen (via Telegram)");
    expect(unb64(body.content)).toBe(insertLine(AREA, "### Aktiv", "- [ ] Ümlaut prüfen"));
  });

  it("versucht es bei 409 einmal mit frischem Stand", async () => {
    let puts = 0;
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init?: RequestInit) => {
      if (init?.method === "PUT") return new Response("{}", { status: ++puts === 1 ? 409 : 200 });
      return Response.json({ content: b64(AREA), sha: `sha${puts}` });
    }));
    expect((await appendEntry(env, "bereiche/steuern.md", "### Aktiv", "- [ ] x")).ok).toBe(true);
    expect(puts).toBe(2);
  });

  it("schreibt nicht, wenn der Abschnitt fehlt", async () => {
    const fetchMock = vi.fn(async () => Response.json({ content: b64(INBOX), sha: "s" }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await appendEntry(env, "bereiche/wiederkehrend.md", "### Aktiv", "- [ ] x");
    expect(r.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
