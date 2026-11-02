import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import type { AppendResult } from "../src/append";
import { ask, confirm, costUsd, type AskDeps } from "../src/ask";
import type { FileResult } from "../src/github";

const usage = { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function text(t: string, stop = "end_turn") {
  return { content: [{ type: "text", text: t }], stop_reason: stop, usage };
}
function readCall(path: string, id = "t1") {
  return { content: [{ type: "tool_use", id, name: "read_file", input: { path } }], stop_reason: "tool_use", usage };
}

const files: Record<string, string> = {
  "CLAUDE.md": "# Regeln",
  "docs/status.md": "# Dashboard",
  "docs/eingang.md": "# Eingang",
  "bereiche/steuern.md": "# Steuern\nAbgabe verpasst",
};

function deps(responses: unknown[]) {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(r);
  const readFile = vi.fn(async (path: string): Promise<FileResult> =>
    path in files ? { ok: true, text: files[path] } : { ok: false, status: 404, error: "GitHub HTTP 404" },
  );
  const appendEntry = vi.fn(async (path: string, section: string, line: string): Promise<AppendResult> => ({ ok: true, path, section, line }));
  const d: AskDeps = {
    client: { messages: { create } } as unknown as AskDeps["client"],
    readFile,
    appendEntry,
    now: () => new Date("2026-11-02T22:30:00Z"), // in Berlin schon 23:30, gleicher Tag
  };
  return { d, create, readFile, appendEntry };
}

type Params = Anthropic.MessageCreateParamsNonStreaming;
const paramsOf = (create: ReturnType<typeof vi.fn>, i: number) => create.mock.calls[i][0] as Params;

describe("ask", () => {
  it("beantwortet direkt mit Haiku 5.5, Regeln gecacht, Dashboard dahinter", async () => {
    const { d, create } = deps([text("Antwort")]);
    expect(await ask("Was ist kritisch?", d)).toBe("Antwort");
    const p = paramsOf(create, 0);
    expect(p.model).toBe("claude-haiku-5-5");
    expect(p.output_config).toEqual({ effort: "low" });
    const system = p.system as Anthropic.TextBlockParam[];
    expect(system[1].text).toContain("# Regeln");
    expect(system[1].cache_control).toEqual({ type: "ephemeral" });
    expect(system[2].text).toContain("# Dashboard");
    expect(system[2].text).toContain("Montag, 02.11.2026");
    expect(system[2].text).toContain("Datum für Einträge: 2026-11-02");
    expect(system[2].cache_control).toBeUndefined();
  });

  it("liest erlaubte Dateien und gibt sie zurück", async () => {
    const { d, create, readFile } = deps([readCall("bereiche/steuern.md"), text("Steuern: verpasst")]);
    expect(await ask("Steuern?", d)).toBe("Steuern: verpasst");
    expect(readFile).toHaveBeenCalledWith("bereiche/steuern.md");
    const result = (paramsOf(create, 1).messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0];
    expect(result.content).toContain("Abgabe verpasst");
    expect(result.is_error).toBeUndefined();
  });

  it.each(["../secrets.md", "docs/../../x.md", "src/index.ts", ".git/config", "bereiche/Steuern.md", "/etc/passwd", "docs/status.txt"])(
    "sperrt Pfad %s, ohne GitHub zu fragen",
    async (path) => {
      const { d, create, readFile } = deps([readCall(path), text("ok")]);
      await ask("x", d);
      expect(readFile).toHaveBeenCalledTimes(3); // nur CLAUDE.md, status, eingang
      const result = (paramsOf(create, 1).messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0];
      expect(result.is_error).toBe(true);
      expect(result.content).toBe("Pfad nicht erlaubt.");
    },
  );

  it("meldet fehlende Dateien als Fehler an das Modell", async () => {
    const { d, create } = deps([readCall("bereiche/gibtsnicht.md"), text("nicht im Repo")]);
    await ask("x", d);
    const result = (paramsOf(create, 1).messages.at(-1)!.content as Anthropic.ToolResultBlockParam[])[0];
    expect(result).toMatchObject({ is_error: true, content: "Datei existiert nicht." });
  });

  it("begrenzt auf 4 Modellaufrufe, der letzte ohne Werkzeuge", async () => {
    const { d, create } = deps([readCall("docs/bauplan.md"), readCall("docs/bauplan.md"), readCall("docs/bauplan.md"), text("Schluss")]);
    expect(await ask("x", d)).toBe("Schluss");
    expect(create).toHaveBeenCalledTimes(4);
    expect(paramsOf(create, 2).tool_choice).toBeUndefined();
    expect(paramsOf(create, 3).tool_choice).toEqual({ type: "none" });
  });

  it("antwortet auch, wenn das Modell im letzten Aufruf trotzdem ein Werkzeug will", async () => {
    const both = { content: [{ type: "text", text: "Teilantwort" }, { type: "tool_use", id: "x", name: "read_file", input: { path: "docs/bauplan.md" } }], stop_reason: "tool_use", usage };
    const { d, create } = deps([readCall("docs/bauplan.md"), readCall("docs/bauplan.md"), readCall("docs/bauplan.md"), both]);
    expect(await ask("x", d)).toBe("Teilantwort");
    expect(create).toHaveBeenCalledTimes(4);
  });

  it("gibt Ablehnungen nicht als Antwort aus", async () => {
    const { d } = deps([text("", "refusal")]);
    expect(await ask("x", d)).toBe("Dazu kann ich nichts sagen (vom Modell abgelehnt).");
  });

  it("markiert abgeschnittene Antworten", async () => {
    const { d } = deps([text("Lang", "max_tokens")]);
    expect(await ask("x", d)).toBe("Lang … (abgeschnitten)");
  });

  it("übersetzt API-Fehler, ohne Details durchzureichen", async () => {
    const { d, create } = deps([]);
    create.mockRejectedValueOnce(new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key sk-geheim", new Headers()));
    const out = await ask("x", d);
    expect(out).toContain("ANTHROPIC_API_KEY prüfen");
    expect(out).not.toContain("sk-geheim");
  });

  it("bricht ab, wenn CLAUDE.md fehlt", async () => {
    const { d, create, readFile } = deps([]);
    readFile.mockImplementation(async () => ({ ok: false, status: 401, error: "GitHub HTTP 401" }));
    expect(await ask("x", d)).toBe("Konnte CLAUDE.md nicht laden (GitHub HTTP 401).");
    expect(create).not.toHaveBeenCalled();
  });

  it("rechnet Kosten mit Haiku-5.5-Listenpreisen", () => {
    // 1M Input, 1M Cache-Write, 1M Cache-Read, 1M Output = 0,10 + 0,125 + 0,01 + 0,50
    expect(costUsd({ calls: 1, input: 1e6, cacheWrite: 1e6, cacheRead: 1e6, output: 1e6 })).toBeCloseTo(0.735);
  });
});

function appendCall(path: string, section: string, line: string, id = "a1") {
  return { content: [{ type: "tool_use", id, name: "append_entry", input: { path, section, line } }], stop_reason: "tool_use", usage };
}
const lastResults = (create: ReturnType<typeof vi.fn>, i: number) => paramsOf(create, i).messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];

describe("Erfassen", () => {
  it("legt ab und bestätigt aus dem, was wirklich gespeichert wurde", async () => {
    const { d, appendEntry } = deps([
      appendCall("bereiche/privat-todos.md", "### Aktiv", "- [ ] Zahnarzt anrufen · standard [P] · fällig 2026-11-03"),
      text("Priorität standard, weil niemand wartet."),
    ]);
    const out = await ask("Morgen Zahnarzt anrufen", d);
    expect(appendEntry).toHaveBeenCalledWith(
      "bereiche/privat-todos.md",
      "### Aktiv",
      "- [ ] Zahnarzt anrufen · standard [P] · fällig 2026-11-03 · Telegram 2026-11-02",
    );
    expect(out).toBe("Abgelegt: privat-todos › Aktiv\nPriorität standard, weil niemand wartet.");
  });

  it("schreibt nichts, wenn die Zeile gegen eine Sperre verstößt, und sagt dem Modell warum", async () => {
    const { d, create, appendEntry } = deps([
      appendCall("bereiche/steuern.md", "### Aktiv", "- [x] Steuererklärung"),
      text("Das darf nur Alex."),
    ]);
    const out = await ask("Steuer ist erledigt", d);
    expect(appendEntry).not.toHaveBeenCalled();
    expect(lastResults(create, 1)[0]).toMatchObject({ is_error: true, content: "Erledigt markieren darf nur Alex." });
    expect(out).toBe("Das darf nur Alex.");
  });

  it.each([
    ["CLAUDE.md", "## 2. Regeln", "- neue Regel"],
    ["docs/decisions.md", "## x", "- 40 | neu"],
    ["bereiche/steuern.md", "## Entscheidungen", "- [ ] x"],
    ["bereiche/steuern.md", "### Aktiv", "- [ ] Steuer · kritisch [A]"],
    ["bereiche/versicherungen.md", "### Aktiv", "- [ ] IBAN DE89370400440532013000 ändern"],
  ])("Sperre: %s › %s", async (path, section, line) => {
    const { d, appendEntry } = deps([appendCall(path, section, line), text("geht nicht")]);
    await ask("x", d);
    expect(appendEntry).not.toHaveBeenCalled();
  });

  it("ersetzt ein behauptetes „Abgelegt“, wenn nichts gespeichert wurde", async () => {
    const { d } = deps([text("Abgelegt: Privat – Zahnarzt")]);
    expect(await ask("Zahnarzt", d)).toBe("Achtung: Es wurde nichts gespeichert. Bitte noch einmal schicken.");
  });

  it("meldet GitHub-Fehler beim Schreiben ans Modell, nicht als Erfolg", async () => {
    const { d, create, appendEntry } = deps([appendCall("bereiche/privat-todos.md", "### Aktiv", "- [ ] x y z"), text("Konnte nicht speichern.")]);
    appendEntry.mockResolvedValueOnce({ ok: false, error: "GitHub HTTP 403 beim Schreiben" });
    expect(await ask("x", d)).toBe("Konnte nicht speichern.");
    expect(lastResults(create, 1)[0]).toMatchObject({ is_error: true });
  });

  it("legt mehrere Punkte aus einer Nachricht ab", async () => {
    const both = {
      content: [
        { type: "tool_use", id: "a", name: "append_entry", input: { path: "bereiche/privat-todos.md", section: "### Aktiv", line: "- [ ] Paket abholen" } },
        { type: "tool_use", id: "b", name: "append_entry", input: { path: "docs/eingang.md", section: "## Unzugeordnet", line: "- → hc-system Bon-Drucker spinnt" } },
      ],
      stop_reason: "tool_use",
      usage,
    };
    const { d, create } = deps([both, text("")]);
    expect(await ask("x", d)).toBe("Abgelegt: privat-todos › Aktiv\nAbgelegt: eingang › Unzugeordnet");
    expect(lastResults(create, 1)).toHaveLength(2);
  });
});

describe("confirm", () => {
  it("lässt normale Antworten ohne Ablage unverändert", () => {
    expect(confirm([], "Kritisch ist die Steuererklärung.")).toBe("Kritisch ist die Steuererklärung.");
  });
  it("lässt „nicht abgelegt“ stehen", () => {
    expect(confirm([], "Nicht abgelegt: das gehört in die Triage.")).toBe("Nicht abgelegt: das gehört in die Triage.");
  });
});
