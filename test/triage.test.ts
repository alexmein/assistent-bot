import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { FileResult } from "../src/github";
import { checkVorbereitung, notice, prepareTriage, renderTriage, telegramLine, type TriageDeps } from "../src/triage";

const punkt = (n: number, fristkritisch = false) => ({ punkt: `Punkt ${n}`, datei: "docs/eingang.md", empfehlung: "bestätigen", begruendung: "weil", fristkritisch });

describe("checkVorbereitung", () => {
  it("bis 40 Punkte, leere fallen weg, unbekannte Empfehlung → klären, Technik an Wortgrenze gekürzt", () => {
    const v = checkVorbereitung({ punkte: [...Array.from({ length: 45 }, (_, i) => punkt(i + 1)), { punkt: "" }], technik: "" });
    expect(v.punkte).toHaveLength(40);
    expect(v.technik).toBeNull();
    expect(checkVorbereitung({ punkte: [{ ...punkt(1), empfehlung: "löschen" }], technik: null }).punkte[0].empfehlung).toBe("klären");
    const long = checkVorbereitung({ punkte: [], technik: "Wort ".repeat(200) }).technik!;
    expect(long.length).toBeLessThanOrEqual(601);
    expect(long.endsWith("Wort …")).toBe(true);
  });
});

describe("Darstellung", () => {
  it("eine Runde ohne Überschrift; Telegram-Zeile", () => {
    const v = checkVorbereitung({ punkte: [punkt(1, true), { ...punkt(2), empfehlung: "parken" }], technik: "Testeinträge entfernen?" });
    const md = renderTriage(v, "2026-11-09");
    expect(md).toContain("1. ⚠ Punkt 1 · `docs/eingang.md` · **bestätigen** – weil\n2. Punkt 2 · `docs/eingang.md` · **parken** – weil");
    expect(md).not.toContain("## Runde");
    expect(md).toContain("**Technik (eine Frage):** Testeinträge entfernen?");
    expect(telegramLine(v)).toBe("Triage liegt bereit: 2 Punkte, davon 1 fristkritisch.");
  });

  it("mehr als 10 Punkte: alle, in Runden zu 10", () => {
    const v = checkVorbereitung({ punkte: Array.from({ length: 23 }, (_, i) => punkt(i + 1)), technik: null });
    const md = renderTriage(v, "2026-11-09");
    expect(md).toContain("## Runde 1\n\n1. Punkt 1");
    expect(md).toMatch(/10\. Punkt 10 [^\n]*\n\n## Runde 2\n\n11\. Punkt 11 /);
    expect(md).toContain("## Runde 3\n\n21. Punkt 21");
    expect(telegramLine(v)).toBe("Triage liegt bereit: 23 Punkte in 3 Runden, davon 0 fristkritisch.");
  });
});

describe("Meldungen (Entscheidung 49)", () => {
  const v = (n: number, k = 0) => checkVorbereitung({ punkte: Array.from({ length: n }, (_, i) => punkt(i + 1, i < k)), technik: null });
  it("montags immer", () => {
    expect(notice(v(3), "Mon", 0)).toBe("Triage liegt bereit: 3 Punkte, davon 0 fristkritisch.");
  });
  it("donnerstags Erinnerung an zusätzliche Triage, wenn mehr als eine Runde offen ist", () => {
    expect(notice(v(11, 2), "Thu", 2)).toBe("Triage: schon 11 Punkte offen, davon 2 fristkritisch – eine zusätzliche Triage vor Montag lohnt sich.");
    expect(notice(v(10), "Thu", 0)).toBeNull();
  });
  it("sonst nur bei neuen fristkritischen Punkten", () => {
    expect(notice(v(5, 1), "Wed", 1)).toBeNull();
    expect(notice(v(5, 2), "Wed", 1)).toBe("Triage: neuer fristkritischer Punkt (2 insgesamt). Triage liegt bereit: 5 Punkte, davon 2 fristkritisch.");
  });
});

describe("prepareTriage", () => {
  it("Sonnet 5.5 mit festem Schema, ohne Werkzeuge, mit Dateien und Commits", async () => {
    const create = vi.fn(async () => ({
      content: [{ type: "text", text: JSON.stringify({ punkte: [punkt(1)], technik: null }) }],
      stop_reason: "end_turn",
      usage: { input_tokens: 6000, output_tokens: 1500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }));
    const d: TriageDeps = {
      readFile: async (p): Promise<FileResult> => ({ ok: true, text: `Inhalt ${p}` }),
      commitsSince: async () => ["docs/eingang.md: Mail X (via Mail)\n\nCo-Authored-By: …"],
      client: { messages: { create } } as unknown as TriageDeps["client"],
      now: () => new Date("2026-11-09T07:45:00Z"),
    };
    const v = await prepareTriage(d, "2026-11-02T20:00:00Z");
    expect(v.punkte).toHaveLength(1);
    const p = (create.mock.calls[0] as unknown[])[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(p.model).toBe("claude-sonnet-5-5");
    expect(p.tools).toBeUndefined();
    expect(p.output_config?.format?.type).toBe("json_schema");
    const content = p.messages[0].content as string;
    expect(content).toContain("Heute: 2026-11-09.\n\n# Commits seit 2026-11-02 (neueste zuerst)");
    expect(content).toContain("- docs/eingang.md: Mail X (via Mail)");
    expect(content).toContain("# bereiche/steuern.md\n\nInhalt bereiche/steuern.md");
    expect(content).not.toContain("Co-Authored-By");
  });
});
