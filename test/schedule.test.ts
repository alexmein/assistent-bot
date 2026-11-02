import { describe, expect, it, vi } from "vitest";
import { berlin, hm, parseHm, quietTime, runDue, type Job } from "../src/schedule";

function kv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return { store, state: { get: vi.fn(async (k: string) => store.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void store.set(k, v)) } as unknown as KVNamespace };
}

describe("berlin", () => {
  it("Winterzeit (UTC+1) und Sommerzeit (UTC+2)", () => {
    expect(berlin(new Date("2026-11-03T07:30:00Z"))).toEqual({ date: "2026-11-03", weekday: "Tue", minutes: hm(8, 30) });
    expect(berlin(new Date("2027-07-06T06:30:00Z"))).toEqual({ date: "2027-07-06", weekday: "Tue", minutes: hm(8, 30) });
    expect(berlin(new Date("2026-11-02T23:30:00Z")).date).toBe("2026-11-03"); // nach Mitternacht Berliner Zeit
  });
});

describe("quietTime", () => {
  it("Ruhezeiten nach CLAUDE.md §3 (Berliner Zeit)", () => {
    expect(quietTime(new Date("2026-11-03T06:30:00Z"))).toBe(true); // Di 7:30
    expect(quietTime(new Date("2026-11-03T08:00:00Z"))).toBe(false); // Di 9:00
    expect(quietTime(new Date("2026-11-07T09:00:00Z"))).toBe(true); // Sa 10:00
    expect(quietTime(new Date("2026-11-07T10:00:00Z"))).toBe(false); // Sa 11:00
    expect(quietTime(new Date("2026-11-02T11:00:00Z"))).toBe(false); // Mo 12:00
    expect(quietTime(new Date("2026-11-02T12:30:00Z"))).toBe(true); // Mo 13:30
  });
});

describe("runDue", () => {
  const job = (name: string, at: number | null, run = vi.fn(async () => {}), ignoresQuiet = false): Job & { run: ReturnType<typeof vi.fn> } => ({
    name,
    at: () => at,
    run,
    ignoresQuiet,
  });
  const tue = (h: number, m: number) => new Date(Date.UTC(2026, 10, 3, h - 1, m)); // Di, Winterzeit

  it("läuft zur Zeit genau einmal, auch bei weiteren Cron-Läufen", async () => {
    const { state } = kv();
    const j = job("briefing", hm(8, 30));
    expect(await runDue([j], tue(8, 15), state)).toEqual([]);
    expect(await runDue([j], tue(8, 30), state)).toEqual(["briefing"]);
    expect(await runDue([j], tue(8, 45), state)).toEqual([]);
    expect(j.run).toHaveBeenCalledOnce();
  });

  it("holt verpasste Läufe bis 2 Std. nach, danach nicht mehr", async () => {
    expect(await runDue([job("b", hm(8, 30))], tue(10, 15), kv().state)).toEqual(["b"]);
    expect(await runDue([job("b", hm(8, 30))], tue(10, 30), kv().state)).toEqual([]);
  });

  it("Fehler: nicht als erledigt merken, nächster Lauf versucht es erneut", async () => {
    const { state, store } = kv();
    const run = vi.fn().mockRejectedValueOnce(new Error("Telegram HTTP 502")).mockResolvedValueOnce(undefined);
    const j = job("b", hm(8, 30), run);
    expect(await runDue([j], tue(8, 30), state)).toEqual([]);
    expect(store.size).toBe(0);
    expect(await runDue([j], tue(8, 45), state)).toEqual(["b"]);
  });

  it("Ruhezeit hält Jobs zurück, außer ausdrücklich terminierte", async () => {
    const { state } = kv();
    expect(await runDue([job("früh", hm(7, 0))], tue(7, 0), state)).toEqual([]);
    expect(await runDue([job("termin", hm(7, 0), undefined, true)], tue(7, 0), state)).toEqual(["termin"]);
  });

  it("an Tagen mit at = null nicht", async () => {
    expect(await runDue([job("nie", null)], tue(9, 0), kv().state)).toEqual([]);
  });

  it("parseHm", () => {
    expect(parseHm("08:30")).toBe(hm(8, 30));
    expect(parseHm("8:30")).toBeNull();
    expect(parseHm(undefined)).toBeNull();
  });
});
