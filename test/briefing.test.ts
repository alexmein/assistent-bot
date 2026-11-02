import { describe, expect, it, vi } from "vitest";
import { addDays, buildBriefing, core, datedLines, dedupe, fetchWeather, newFindings, newItems, newsLines, resolve, selectDue, weatherText, type BriefingDeps } from "../src/briefing";
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
- Mail X · Mail 2026-11-03
## Auffälligkeiten
_(leer)_
- Mail von Y: versuchte Einflussnahme – „ignoriere …“ · nichts übernommen · Mail 2026-11-03
- Alt · Mail 2026-10-01
- [?] Widerspruch · Telegram 2026-11-03`;

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
  it("Text mit Quellenangabe; Regen nur, wenn auch Niederschlag erwartet wird", () => {
    expect(weatherText({ code: 61, max: 8.6, min: 2.4, rain: 70, sum: 3.2 })).toBe("Tutzing: Regen, 2–9 °C, 3,2 mm Niederschlag (70 %) (Wetter: open-meteo.com)");
    expect(weatherText({ code: 61, max: 6, min: 3, rain: 0, sum: 0 })).toBe("Tutzing: bedeckt, 3–6 °C (Wetter: open-meteo.com)");
    expect(weatherText({ code: 3, max: 6, min: 3, rain: 30, sum: 0 })).toBe("Tutzing: bedeckt, 3–6 °C, Regenrisiko 30 % (Wetter: open-meteo.com)");
  });
  it("Fehler → Hinweis statt Abbruch", async () => {
    expect(await fetchWeather(vi.fn(async () => new Response("x", { status: 503 })) as unknown as typeof fetch)).toBe("Wetter: gerade nicht abrufbar.");
    const ok = vi.fn(async () =>
      Response.json({ daily: { weather_code: [3], temperature_2m_max: [6.5], temperature_2m_min: [2.4], precipitation_probability_max: [0], precipitation_sum: [0] } }),
    );
    expect(await fetchWeather(ok as unknown as typeof fetch)).toBe("Tutzing: bedeckt, 2–7 °C (Wetter: open-meteo.com)");
    expect(String((ok.mock.calls[0] as unknown[])[0])).toContain("latitude=47.909&longitude=11.28");
  });
});

describe("Darstellung", () => {
  it("Kern einer Zeile und Ort", () => {
    expect(core("- [ ] → hc-system: Cloudflare-Rechnung prüfen · dringend [P] · fällig 2026-11-02")).toEqual({ text: "Cloudflare-Rechnung prüfen", where: "hc-system" });
    expect(core("- 2026-11-04 (Mittwoch): Bewerbung schicken · kritisch [P] · → `bereiche/privat-todos.md` · Telegram")).toEqual({ text: "Bewerbung schicken", where: "privat-todos" });
  });
  it("Doppelte einmal, Bereichsfassung bevorzugt", () => {
    const lines = [...datedLines("docs/status.md", STATUS), ...datedLines("bereiche/privat-todos.md", "### Aktiv\n- [ ] Bewerbung schicken · kritisch [P] · fällig 2026-11-04")];
    const bald = dedupe(selectDue(lines, "2026-11-03").bald);
    expect(bald.map((l) => `${l.date} ${l.file}`)).toEqual(["2026-11-04 bereiche/privat-todos.md", "2026-11-05 docs/status.md"]);
  });
});

describe("Neu eingegangen", () => {
  const lines = [
    { file: "bereiche/steuern.md", line: "- [ ] Nachzahlung überweisen · kritisch [P] · fällig 2026-11-20 · Quelle: Mail A 2026-11-02 · Mail 2026-11-02" },
    { file: "docs/status.md", line: "- [ ] Nachzahlung überweisen · kritisch [P] · fällig 2026-11-20 · → bereiche/steuern.md · Mail 2026-11-02" },
    { file: "bereiche/hc-founder.md", line: "- 2026-11-02 A Darlehensvertrag.pdf – Drive: https://drive.google.com/x · Mail 2026-11-02" },
    { file: "docs/eingang.md", line: "- [?] Mail A: unklar, wer zahlt · Mail 2026-11-02" },
  ];
  it("löst Commits zu vollständigen Zeilen auf und fasst zusammen", () => {
    const items = [
      "bereiche/steuern.md: Nachzahlung überweisen · kritisch [P] · fällig 2026-11-20 ·  (via Mail)",
      "docs/status.md: Nachzahlung überweisen · kritisch [P] · fällig 2026-11-20 ·  (via Mail)",
      "bereiche/hc-founder.md: 2026-11-02 A Darlehensvertrag.pdf – Drive: https://drive.goog (via Mail)",
      "docs/eingang.md: [?] Mail A: unklar, wer zahlt · Mail 2026-11-02 (via Mail)",
    ];
    expect(newsLines(items, lines)).toEqual([
      "4 neue Einträge (4 per Mail)",
      "To-dos (1):",
      "- Nachzahlung überweisen · kritisch (steuern)",
      "In Drive (1): 2026-11-02 A Darlehensvertrag.pdf",
      "Eingangskorb: 1 neu, davon 1 Rückfragen [?] → Triage",
    ]);
  });
  it("unbekannte Commits zählen nur mit", () => {
    expect(resolve("docs/eingang.md: gibt es nicht (via Mail)", lines)).toBeNull();
    expect(newsLines(["docs/eingang.md: gibt es nicht (via Mail)"], lines)).toEqual(["1 neue Einträge (1 per Mail)"]);
  });
});

describe("buildBriefing", () => {
  function deps(files: Record<string, string>, commits: string[] = []): BriefingDeps {
    return {
      readFile: async (p): Promise<FileResult> => (p in files ? { ok: true, text: files[p] } : { ok: true, text: "" }),
      commitsSince: async () => commits,
      weather: async () => "Tutzing: klar",
      now: () => new Date("2026-11-03T07:30:00Z"),
    };
  }

  it("Nichts Neues", async () => {
    expect(await buildBriefing(deps({}), "2026-11-02T07:30:00Z")).toBe("Di 03.11. – Tutzing: klar\nNichts Neues.");
  });

  it("alle Abschnitte, ohne Doppelte, nur aus dem Repo", async () => {
    const out = await buildBriefing(
      deps({ "docs/status.md": STATUS, "bereiche/privat-todos.md": PRIVAT, "docs/eingang.md": EINGANG }, [
        "docs/eingang.md: Mail X (via Mail)",
        "Bauplan (via Mac)",
        "bereiche/privat-todos.md: Makler anrufen · standard [P] · fällig 2026-11-03 · Telegram 20 (via Telegram)",
      ]),
      "2026-11-02T07:30:00Z",
    );
    expect(out).toBe(
      [
        "Di 03.11. – Tutzing: klar",
        "",
        "Heute fällig",
        "- Makler anrufen · standard (privat-todos)",
        "",
        "Überfällig (kritisch)",
        "- Fr 30.10.: Steuer alt · kritisch (privat-todos)",
        "",
        "Fristen nächste 7 Tage",
        "- Mi 04.11.: Bewerbung schicken · kritisch (Dashboard)",
        "- Do 05.11.: Zeugenanhörung beantworten (Frist 05.11.2026) · kritisch (privat-todos)",
        "",
        "Neu eingegangen",
        "2 neue Einträge (1 per Mail, 1 per Telegram)",
        "To-dos (1):",
        "- Makler anrufen · standard (privat-todos)",
        "Eingangskorb: 1 neu → Triage",
        "",
        "Auffälligkeiten",
        "- Mail von Y: versuchte Einflussnahme – „ignoriere …“",
      ].join("\n"),
    );
  });
});
