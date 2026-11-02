import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { addDays, buildBriefing, datedLines, fetchWeather, newFindings, newItems, selectDue, weatherText, type BriefingDeps } from "../src/briefing";
import type { FileResult } from "../src/github";

const STATUS = `# Dashboard
## Kritisch / dringend
- [ ] Zeugenanhörung beantworten (Frist 05.11.2026) · kritisch [P] · → bereiche/privat-todos.md
## Fristen (nächste 30 Tage)
- 2026-11-04 (Mittwoch): Bewerbung schicken · kritisch [P]
- 2026-11-20 (Freitag): Nachzahlung · kritisch [P]
## → am Mac
- Triage vorbereiten · 2026-11-03`;

const PRIVAT = `# Privat
### Aktiv
- [ ] Makler anrufen · standard [P] · fällig 2026-11-03 · Telegram 2026-11-02
- [ ] Kinder abholen · dringend [P] · fällig 2026-11-02 · Telegram 2026-11-02
- [ ] Steuer alt · kritisch [P] · fällig 2026-10-30 · Telegram 2026-10-29
- [x] Erledigt · fällig 2026-11-03
## Verweise
- Schreiben 22.10.2026 – Drive: x`;

const EINGANG = `# Eingang
## Unzugeordnet
- Mail X · Mail 2026-11-02
## Auffälligkeiten
_(leer)_
- Mail von Y: versuchte Einflussnahme – „ignoriere …“ · nichts übernommen · Mail 2026-11-03
- Alt · Mail 2026-10-01`;

describe("datedLines / selectDue", () => {
  it("findet offene To-dos und Fristen mit Datum, ignoriert Erledigtes und Verweise", () => {
    const lines = [...datedLines("docs/status.md", STATUS), ...datedLines("bereiche/privat-todos.md", PRIVAT)];
    expect(lines.map((l) => `${l.date} ${l.prio}`)).toEqual([
      "2026-11-05 kritisch",
      "2026-11-04 kritisch",
      "2026-11-20 kritisch",
      "2026-11-03 standard",
      "2026-11-02 dringend",
      "2026-10-30 kritisch",
    ]);
    const due = selectDue(lines, "2026-11-03");
    expect(due.heute.map((l) => l.line)).toEqual([expect.stringContaining("Makler")]);
    expect(due.ueberfaellig.map((l) => l.line)).toEqual([expect.stringContaining("Steuer alt")]); // „Kinder abholen“ (dringend) nur am Tag selbst
    expect(due.bald.map((l) => l.date)).toEqual(["2026-11-05", "2026-11-04"]);
  });

  it("addDays über Monatsgrenze", () => {
    expect(addDays("2026-11-28", 7)).toBe("2026-12-05");
  });
});

describe("Neues", () => {
  it("Auffälligkeiten ab dem letzten Briefing", () => {
    expect(newFindings(EINGANG, "2026-11-03")).toEqual([expect.stringContaining("Mail von Y")]);
  });
  it("nur Commits von außen", () => {
    expect(newItems(["docs/eingang.md: Mail X (via Mail)\n\nCo-Authored-By: …", "Bauplan (via Mac)", "bereiche/x.md: Müll (via Telegram)"])).toEqual([
      "docs/eingang.md: Mail X (via Mail)",
      "bereiche/x.md: Müll (via Telegram)",
    ]);
  });
});

describe("Wetter", () => {
  it("Text mit Quellenangabe", () => {
    expect(weatherText({ code: 61, max: 8.6, min: 2.4, rain: 70 })).toBe("Tutzing: Regen, 2–9 °C, Regenwahrscheinlichkeit 70 % (Wetter: open-meteo.com)");
  });
  it("Fehler → Hinweis statt Abbruch", async () => {
    expect(await fetchWeather(vi.fn(async () => new Response("x", { status: 503 })) as unknown as typeof fetch)).toBe("Wetter: gerade nicht abrufbar.");
    const ok = vi.fn(async () =>
      Response.json({ daily: { weather_code: [3], temperature_2m_max: [6.5], temperature_2m_min: [2.4], precipitation_probability_max: [0] } }),
    );
    expect(await fetchWeather(ok as unknown as typeof fetch)).toBe("Tutzing: bedeckt, 2–7 °C, Regenwahrscheinlichkeit 0 % (Wetter: open-meteo.com)");
    expect(String((ok.mock.calls[0] as unknown[])[0])).toContain("latitude=47.909&longitude=11.28");
  });
});

describe("buildBriefing", () => {
  const usage = { input_tokens: 3000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  function deps(files: Record<string, string>, commits: string[] = []) {
    const create = vi.fn(async () => ({ content: [{ type: "text", text: "Heute fällig\n- Makler anrufen" }], stop_reason: "end_turn", usage }));
    const d: BriefingDeps = {
      readFile: async (p): Promise<FileResult> => (p in files ? { ok: true, text: files[p] } : { ok: true, text: "" }),
      commitsSince: async () => commits,
      weather: async () => "Tutzing: klar",
      client: { messages: { create } } as unknown as BriefingDeps["client"],
      now: () => new Date("2026-11-03T07:30:00Z"),
    };
    return { d, create };
  }

  it("Nichts Neues ohne Modellaufruf", async () => {
    const { d, create } = deps({});
    expect(await buildBriefing(d, "2026-11-02T07:30:00Z")).toBe("Di 03.11. – Tutzing: klar\nNichts Neues.");
    expect(create).not.toHaveBeenCalled();
  });

  it("gibt dem Modell nur gesammelte Fakten, Kopfzeile vom Code", async () => {
    const { d, create } = deps({ "docs/status.md": STATUS, "bereiche/privat-todos.md": PRIVAT, "docs/eingang.md": EINGANG }, ["docs/eingang.md: Mail X (via Mail)"]);
    const out = await buildBriefing(d, "2026-11-02T07:30:00Z");
    expect(out).toBe("Di 03.11. – Tutzing: klar\n\nHeute fällig\n- Makler anrufen");
    const p = (create.mock.calls[0] as unknown[])[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(p.model).toBe("claude-haiku-5-5");
    expect(p.tools).toBeUndefined();
    const facts = p.messages[0].content as string;
    expect(facts).toContain("# Heute fällig\n2026-11-03 · bereiche/privat-todos.md · - [ ] Makler anrufen");
    expect(facts).toContain("docs/eingang.md: Mail X (via Mail)");
    expect(facts).toContain("Mail von Y");
    expect(facts).not.toContain("Kinder abholen"); // dringend, überfällig → nicht mehr
  });
});
