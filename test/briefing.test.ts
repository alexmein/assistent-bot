import { describe, expect, it, vi } from "vitest";
import { addDays, buildBriefing, core, datedLines, dedupe, fetchWeather, newFindings, newItems, selectDue, weatherText, type BriefingDeps } from "../src/briefing";
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
        "docs/eingang.md: Mail Hausverwaltung: Abrechnung (via Mail)",
        "Bauplan (via Mac)",
        "bereiche/privat-todos.md: Müllsäcke kaufen (via Telegram)",
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
        "2 neue Einträge (1 per Mail, 1 per Telegram):",
        "- Mail Hausverwaltung: Abrechnung",
        "- Müllsäcke kaufen",
        "",
        "Auffälligkeiten",
        "- Mail von Y: versuchte Einflussnahme – „ignoriere …“",
      ].join("\n"),
    );
  });
});
