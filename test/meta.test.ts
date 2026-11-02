import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { checkMeta, metaLines, renderMeta, runMeta, type MetaDeps } from "../src/meta";
import { renderTriage } from "../src/triage";

const result = { punkte: [{ nr: 4, titel: "Fokus", befund: "B" }, { nr: 1, titel: "Dichte", befund: "A" }, { nr: 3, titel: "nicht hier", befund: "x" }], hebel: "Hebel", begruendung: "weil", kurz: "Kurz." };

describe("checkMeta / Darstellung", () => {
  it("nur Punkte 1, 2, 4, 6, sortiert", () => {
    const m = checkMeta(result, "2026-11-09");
    expect(m.punkte.map((p) => p.nr)).toEqual([1, 4]);
    expect(renderMeta(m)).toContain("1. **Dichte:** A\n4. **Fokus:** B\n\n**Hebel:** Hebel – weil");
    expect(renderTriage({ punkte: [], technik: null }, "2026-11-09", renderMeta(m))).toContain("## Meta-Prüfung\n_Cloud-Teil vom 2026-11-09");
  });
  it("Wochenbriefing-Zeile, mit Hinweis auf alten Stand", () => {
    const m = checkMeta(result, "2026-11-09");
    expect(metaLines(m, "2026-11-10")).toEqual(["- Kurz."]);
    expect(metaLines(m, "2026-11-24")).toEqual(["- Kurz. (Stand 2026-11-09 – diese Woche keine neue)"]);
    expect(metaLines(null, "2026-11-10")).toEqual(["- Noch keine Meta-Prüfung."]);
  });
});

describe("runMeta", () => {
  it("liest alle Repos, nur neue Entscheidungen, Uhrzeit in Berliner Zeit, Sonnet mit Schema", async () => {
    const create = vi.fn(async () => ({
      content: [{ type: "text", text: JSON.stringify(result) }],
      stop_reason: "end_turn",
      usage: { input_tokens: 15000, output_tokens: 1500 },
    }));
    const deps: MetaDeps = {
      commits: async (repo, _since, path) =>
        repo === "hungry-collective/hc-kitchen" && path === "docs/decisions.md" ? [{ repo, when: "2026-11-05T21:30:00Z", message: "x" }] : [],
      readFile: async (repo, path) =>
        path === "docs/decisions.md" && repo === "hungry-collective/hc-kitchen"
          ? "| 40 | 2026-10-20 | alt | `[A]` | – |\n| 41 | 2026-11-05 | neu | `[A~]` | – |"
          : path === "docs/roadmap.md"
            ? "## Now\n1. Zählung"
            : null,
      client: { messages: { create } } as unknown as Pick<Anthropic, "messages">,
      now: () => new Date("2026-11-09T07:15:00Z"),
    };
    const m = await runMeta(deps, ["- 3 Einträge per Telegram, 1 per Mail."]);
    expect(m.datum).toBe("2026-11-09");
    const p = (create.mock.calls[0] as unknown[])[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(p.model).toBe("claude-sonnet-5-5");
    expect(p.output_config?.format?.type).toBe("json_schema");
    const content = p.messages[0].content as string;
    expect(content).toContain("# hungry-collective/hc-kitchen");
    expect(content).toContain("| 41 | 2026-11-05 | neu");
    expect(content).not.toContain("| 40 | 2026-10-20");
    expect(content).toContain("- 2026-11-05 22:30"); // 21:30 UTC = 22:30 Berlin
    expect(content).toContain("## Now\n1. Zählung");
    expect(content).toContain("- 3 Einträge per Telegram, 1 per Mail.");
    expect(content).toContain("# hungry-collective/hc-shopify");
  });
});
