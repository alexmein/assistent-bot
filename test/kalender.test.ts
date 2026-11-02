import { describe, expect, it } from "vitest";
import { calendarLines, easter, holidays, parsePeriods, periodsFor } from "../src/kalender";

describe("Feiertage", () => {
  it("Ostern und bewegliche Feiertage", () => {
    expect(easter(2026)).toBe("2026-04-05");
    expect(easter(2027)).toBe("2027-03-28");
    const h = holidays(2027);
    expect(h.find((p) => p.name.includes("Fronleichnam"))?.start).toBe("2027-05-27");
    expect(h.find((p) => p.name.includes("Christi Himmelfahrt"))?.start).toBe("2027-05-06");
    expect(h).toHaveLength(13);
  });
});

describe("Ferien", () => {
  const KAL = `# Kalender\n## Schulferien\n- 2026-11-02 bis 2026-11-06: Herbstferien\n- 2026-11-18: Buß- und Bettag (schulfrei)\nText - 2026-01-01: kein Eintrag`;
  it("liest Zeiträume und Einzeltage", () => {
    expect(parsePeriods(KAL)).toEqual([
      { start: "2026-11-02", end: "2026-11-06", name: "Herbstferien" },
      { start: "2026-11-18", end: "2026-11-18", name: "Buß- und Bettag (schulfrei)" },
    ]);
  });
  it("heute Laufendes und was in 7 Tagen beginnt", () => {
    expect(calendarLines("2026-11-03", periodsFor("2026-11-03", KAL))).toEqual(["- Läuft: Herbstferien (bis Fr 06.11.)"]);
    expect(calendarLines("2026-11-12", periodsFor("2026-11-12", KAL))).toEqual(["- Mi 18.11.: Buß- und Bettag (schulfrei)"]);
    expect(calendarLines("2026-12-24", periodsFor("2026-12-24", KAL))).toEqual(["- Fr 25.12.: Feiertag: 1. Weihnachtstag", "- Sa 26.12.: Feiertag: 2. Weihnachtstag"]);
    expect(calendarLines("2026-12-25", periodsFor("2026-12-25", ""))[0]).toBe("- Heute: Feiertag: 1. Weihnachtstag");
  });
});
