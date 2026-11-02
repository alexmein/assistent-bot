import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { FileResult } from "../src/github";
import { checkVorbereitung, prepareTriage, renderTriage, telegramLine, type TriageDeps } from "../src/triage";

const punkt = (n: number, fristkritisch = false) => ({ punkt: `Punkt ${n}`, datei: "docs/eingang.md", empfehlung: "bestätigen", begruendung: "weil", fristkritisch });

describe("checkVorbereitung", () => {
  it("höchstens 10 Punkte, Rest zählt zu „weitere“, unbekannte Empfehlung → klären", () => {
    const v = checkVorbereitung({ punkte: [...Array.from({ length: 12 }, (_, i) => punkt(i + 1)), { punkt: "" }], technik: "", weitere: 2 });
    expect(v.punkte).toHaveLength(10);
    expect(v.weitere).toBe(4);
    expect(v.technik).toBeNull();
    expect(checkVorbereitung({ punkte: [{ ...punkt(1), empfehlung: "löschen" }], technik: null, weitere: 0 }).punkte[0].empfehlung).toBe("klären");
  });
});

describe("Darstellung", () => {
  it("Format nach §6 und Telegram-Zeile", () => {
    const v = checkVorbereitung({ punkte: [punkt(1, true), { ...punkt(2), empfehlung: "parken" }], technik: "Testeinträge entfernen?", weitere: 3 });
    expect(renderTriage(v, "2026-11-09")).toContain("1. ⚠ Punkt 1 · `docs/eingang.md` · **bestätigen** – weil\n2. Punkt 2 · `docs/eingang.md` · **parken** – weil");
    expect(renderTriage(v, "2026-11-09")).toContain("**Technik (eine Frage):** Testeinträge entfernen?");
    expect(renderTriage(v, "2026-11-09")).toContain("_3 weitere Punkte in der nächsten Runde._");
    expect(telegramLine(v)).toBe("Triage liegt bereit: 2 Punkte, davon 1 fristkritisch.");
  });
});

describe("prepareTriage", () => {
  it("Sonnet 5.5 mit festem Schema, ohne Werkzeuge, mit Dateien und Commits", async () => {
    const create = vi.fn(async () => ({
      content: [{ type: "text", text: JSON.stringify({ punkte: [punkt(1)], technik: null, weitere: 0 }) }],
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
    expect(content).toContain("Heute: 2026-11-09. Letzte Vorbereitung: 2026-11-02.");
    expect(content).toContain("- docs/eingang.md: Mail X (via Mail)");
    expect(content).toContain("# bereiche/steuern.md\n\nInhalt bereiche/steuern.md");
    expect(content).not.toContain("Co-Authored-By");
  });
});
