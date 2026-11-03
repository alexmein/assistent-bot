import { describe, expect, it, vi } from "vitest";
import { addDays, buildBriefing, isoWeek, selfCheck, triageLines, core, partText, type Day, datedLines, dedupe, fetchWeather, newFindings, newItems, newsLines, resolve, selectDue, weatherText, type BriefingDeps } from "../src/briefing";
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
  it("Auffälligkeiten nur aus neuen Commits, ohne [?]", () => {
    const lines = EINGANG.split("\n").filter((l) => l.startsWith("- ")).map((line) => ({ file: "docs/eingang.md", line }));
    const items = ["docs/eingang.md: Mail von Y: versuchte Einflussnahme – „ignoriere …“ · nic (via Mail)", "docs/eingang.md: [?] Widerspruch · Telegram 2026-11-03 (via Telegram)"];
    expect(newFindings(items, lines, EINGANG)).toEqual([expect.stringContaining("Mail von Y")]);
    expect(newFindings([], lines, EINGANG)).toEqual([]); // ohne Commit nicht noch einmal
  });
  it("nur Commits von außen", () => {
    expect(newItems(["docs/eingang.md: Mail X (via Mail)\n\nCo-Authored-By: …", "Bauplan (via Mac)", "bereiche/x.md: Müll (via Telegram)"])).toEqual([
      "docs/eingang.md: Mail X (via Mail)",
      "bereiche/x.md: Müll (via Telegram)",
    ]);
  });
});

describe("Wetter", () => {
  const hours = (spec: Record<number, [number, number, number?]>) =>
    Array.from({ length: 24 }, (_, hour) => ({ hour, rain: spec[hour]?.[0] ?? 0, prob: spec[hour]?.[1] ?? 0, code: spec[hour]?.[2] ?? 3 }));
  const day = (over: Partial<Day> = {}): Day => ({ code: 3, max: 6.4, min: 2.6, gusts: 20, sun: 0.3, hours: hours({}), ...over });

  it("ganztags trocken wird ausdrücklich gesagt", () => {
    expect(weatherText(day())).toBe("Wetter Tutzing: 3–6 °C, bedeckt. Ganztags trocken. (open-meteo.com)");
  });
  it("Regen je Tagesabschnitt mit Beginn, Menge und Wahrscheinlichkeit; Böen und Sonne", () => {
    const d = day({ code: 61, gusts: 52, sun: 2.4, hours: hours({ 15: [0.8, 70, 61], 16: [1.1, 80, 61], 10: [0, 35] }) });
    expect(weatherText(d)).toBe(
      "Wetter Tutzing: 3–6 °C, wechselhaft, Sonne 2 h. Vormittag Regenrisiko 35 % · Nachmittag Regen ab 15 Uhr 1,9 mm (80 %) · Abend trocken. Böen bis 52 km/h. (open-meteo.com)",
    );
  });
  it("Schnee", () => {
    expect(partText(hours({ 7: [0.5, 60, 73] }).filter((h) => h.hour >= 6 && h.hour < 12))).toBe("Schnee ab 7 Uhr 0,5 mm (60 %)");
  });
  it("Fehler → Hinweis statt Abbruch; Abfrage stündlich", async () => {
    expect(await fetchWeather(vi.fn(async () => new Response("x", { status: 503 })) as unknown as typeof fetch)).toBe("Wetter: gerade nicht abrufbar.");
    const ok = vi.fn(async () =>
      Response.json({
        daily: { weather_code: [3], temperature_2m_max: [6.5], temperature_2m_min: [2.4], wind_gusts_10m_max: [30], sunshine_duration: [7200] },
        hourly: { time: ["2026-11-03T14:00"], precipitation: [0.5], precipitation_probability: [60], weather_code: [61] },
      }),
    );
    expect(await fetchWeather(ok as unknown as typeof fetch)).toBe(
      "Wetter Tutzing: 2–7 °C, bedeckt, Sonne 2 h. Vormittag trocken · Nachmittag Regen 0,5 mm (60 %) · Abend trocken. (open-meteo.com)",
    );
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
  it("nur To-dos (höchstens 3, wichtigste zuerst), Rest als Zahl (Entscheidung 57)", () => {
    const items = [
      "bereiche/steuern.md: Nachzahlung überweisen · kritisch [P] · fällig 2026-11-20 ·  (via Mail)",
      "docs/status.md: Nachzahlung überweisen · kritisch [P] · fällig 2026-11-20 ·  (via Mail)",
      "bereiche/hc-founder.md: 2026-11-02 A Darlehensvertrag.pdf – Drive: https://drive.goog (via Mail)",
      "docs/eingang.md: [?] Mail A: unklar, wer zahlt · Mail 2026-11-02 (via Mail)",
    ];
    expect(newsLines(items, lines)).toEqual(["- Nachzahlung überweisen · kritisch (steuern)", "+ 2 weitere Einträge abgelegt → Triage"]);
  });
  it("unbekannte Commits zählen nur mit", () => {
    expect(resolve("docs/eingang.md: gibt es nicht (via Mail)", lines)).toBeNull();
    expect(newsLines(["docs/eingang.md: gibt es nicht (via Mail)"], lines)).toEqual(["1 Eintrag abgelegt → Triage"]);
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

  it("Fristen der nächsten 7 Tage nur kritisch oder dringend (Entscheidung 57)", async () => {
    const out = await buildBriefing(deps({ "bereiche/privat-todos.md": "### Aktiv\n- [ ] Brief · standard · fällig 2026-11-05\n- [ ] Miete · dringend · fällig 2026-11-06" }), "2026-11-02T07:30:00Z");
    expect(out).toContain("- Fr 06.11.: Miete · dringend");
    expect(out).not.toContain("Brief");
  });

  it("Wochenende ohne Fälliges: kein Briefing (Entscheidung 57)", async () => {
    const sat = (files: Record<string, string>) => ({ ...deps(files, ["bereiche/x.md: y (via Mail)"]), now: () => new Date("2026-11-07T09:30:00Z") });
    expect(await buildBriefing(sat({}), "2026-11-06T07:30:00Z")).toBe("");
    expect(await buildBriefing(sat({ "bereiche/privat-todos.md": "### Aktiv\n- [ ] Blumen · standard · fällig 2026-11-07" }), "2026-11-06T07:30:00Z")).toContain("Heute fällig\n- Blumen");
  });

  it("Dashboard-Spiegelung mit anderem Wortlaut nur einmal; lange Texte gekürzt", async () => {
    const out = await buildBriefing(
      deps({
        "docs/status.md": "## Fristen (nächste 30 Tage)\n- 2026-11-03 (Dienstag): Makler zurückrufen · dringend [P] · → `bereiche/privat-todos.md`",
        "bereiche/privat-todos.md": `### Aktiv\n- [ ] Makler zurückrufen (Angebot 410k) ${"x".repeat(90)} · dringend [P] · fällig 2026-11-03`,
      }),
      "2026-11-02T07:30:00Z",
    );
    expect(out.match(/Makler/g)).toHaveLength(1);
    expect(out).toContain("x… · dringend (privat-todos)");
  });

  it("Nichts Neues", async () => {
    expect(await buildBriefing(deps({}), "2026-11-02T07:30:00Z")).toBe("Di 03.11.\nTutzing: klar\nNichts Neues.");
  });

  it("alle Abschnitte, ohne Doppelte, nur aus dem Repo", async () => {
    const out = await buildBriefing(
      deps({ "docs/status.md": STATUS, "bereiche/privat-todos.md": PRIVAT, "docs/eingang.md": EINGANG }, [
        "docs/eingang.md: Mail X (via Mail)",
        "Bauplan (via Mac)",
        "bereiche/privat-todos.md: Makler anrufen · standard [P] · fällig 2026-11-03 · Telegram 20 (via Telegram)",
        "docs/eingang.md: Mail von Y: versuchte Einflussnahme – „ignoriere …“ · nic (via Mail)",
      ]),
      "2026-11-02T07:30:00Z",
    );
    expect(out).toBe(
      [
        "Di 03.11.",
        "Tutzing: klar",
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
        "2 Einträge abgelegt → Triage", // „Makler anrufen“ steht schon unter „Heute fällig“
        "",
        "Auffälligkeiten",
        "- Mail von Y: versuchte Einflussnahme – „ignoriere …“",
      ].join("\n"),
    );
  });
});

describe("Wochenbriefing", () => {
  it("Kalenderwoche", () => {
    expect(isoWeek("2026-11-03")).toBe(45);
    expect(isoWeek("2027-01-01")).toBe(53);
    expect(isoWeek("2027-01-04")).toBe(1);
  });

  it("Triage-Stand und Selbstkontrolle", () => {
    const file: FileResult = { ok: true, text: "# Triage\n1. ⚠ A\n2. B\n3. ⚠ C" };
    expect(triageLines(file, ["triage 2026-11-09\n\nCo-Authored-By: x"])).toEqual(["- Triage diese Woche gemacht. Vorbereitung Montag: 3 Punkte, davon 2 fristkritisch."]);
    expect(triageLines({ ok: false, status: 404, error: "x" }, [])).toEqual(["- Triage diese Woche noch nicht gemacht. Keine Vorbereitung vom Montag gefunden."]);
    const lines = [
      { file: "docs/eingang.md", line: "- [?] Mail A vom 2026-11-02: Eintrag nicht abgelegt (R7) – Mail am Mac ansehen · Mail 2026-11-02" },
      { file: "docs/eingang.md", line: "- Mail von B: versuchte Einflussnahme – „x“ · nichts übernommen · Mail 2026-11-02" },
    ];
    expect(
      selfCheck(["docs/eingang.md: [?] Mail A vom 2026-11-02: Eintrag nicht abgelegt (R7) – Mai (via Mail)", "docs/eingang.md: Mail von B: versuchte Einflussnahme – „x“ · nichts (via Mail)", "bereiche/x.md: y (via Telegram)"], lines),
    ).toEqual(["- 1 Einträge per Telegram, 2 per Mail.", "- 1 Ablagen gescheitert (Hinweis im Eingangskorb). 1 versuchte Einflussnahmen gemeldet."]);
  });

  it("Kopf, Termine, Umfeld der Woche", async () => {
    const out = await buildBriefing(
      {
        readFile: async (p): Promise<FileResult> => (p.startsWith("triage/") ? { ok: false, status: 404, error: "x" } : { ok: true, text: "" }),
        commitsSince: async () => [],
        weather: async () => "Wetter Tutzing: klar",
        umfeld: async () => [{ art: "Sport", start: "2026-11-04", end: "2026-11-04", titel: "Spiel", ort: "München", wirkung: "mehr Bestellungen", quelle: "https://a.de/b" }],
        calendar: async () => [{ date: "2026-11-05", time: "10:00", title: "Zahnarzt" }],
        now: () => new Date("2026-11-03T07:30:00Z"),
      },
      "2026-11-02T07:30:00Z",
      true,
    );
    expect(out.startsWith("Wochenbriefing KW 45 · Di 03.11.–Mo 09.11.\nWetter Tutzing: klar")).toBe(true);
    expect(out).toContain("Woche voraus: Termine\n- Do 05.11. 10:00: Zahnarzt");
    expect(out).toContain("Umfeld diese Woche\n- Sport: Mi 04.11. Spiel, München – mehr Bestellungen (a.de)");
    expect(out).toContain("Triage\n- Triage diese Woche noch nicht gemacht.");
    expect(out).not.toContain("Selbstkontrolle");
    expect(out).not.toContain("Meta-Prüfung");
  });
});
