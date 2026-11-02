import { describe, expect, it, vi } from "vitest";
import { addReminder, berlinToUtc, checkReminder, label, listReminders, sendDue } from "../src/reminders";

function kv() {
  const store = new Map<string, { metadata?: unknown }>();
  return {
    store,
    kv: {
      put: vi.fn(async (k: string, _v: string, o?: { metadata?: unknown }) => void store.set(k, { metadata: o?.metadata })),
      delete: vi.fn(async (k: string) => void store.delete(k)),
      list: vi.fn(async ({ prefix }: { prefix: string }) => ({
        keys: [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata })),
      })),
    } as unknown as KVNamespace,
  };
}

describe("Zeit", () => {
  it("Berliner Zeit → UTC in Winter- und Sommerzeit", () => {
    expect(berlinToUtc("2026-11-03", "14:00")?.toISOString()).toBe("2026-11-03T13:00:00.000Z");
    expect(berlinToUtc("2027-07-01", "14:00")?.toISOString()).toBe("2027-07-01T12:00:00.000Z");
    expect(berlinToUtc("2027-03-28", "02:30")).toBeNull(); // fällt in die Zeitumstellung
    expect(berlinToUtc("2026-13-01", "10:00")).toBeNull();
    expect(label(new Date("2026-11-03T13:00:00Z"))).toBe("Di 03.11. 14:00");
  });

  it("prüft Eingaben", () => {
    const now = new Date("2026-11-02T20:00:00Z");
    expect(checkReminder({ date: "2026-11-03", time: "14:00", text: "Makler anrufen" }, now)).toMatchObject({ ok: true, text: "Makler anrufen" });
    expect(checkReminder({ date: "2026-11-02", time: "20:00", text: "x" }, now)).toMatchObject({ ok: false });
    expect(checkReminder({ date: "2026-11-02", time: "20:00", text: "zu spät" }, now)).toEqual({ ok: false, error: "Zeitpunkt liegt in der Vergangenheit." });
    expect(checkReminder({ date: "2028-01-01", time: "10:00", text: "zu weit" }, now)).toEqual({ ok: false, error: "Höchstens ein Jahr im Voraus." });
  });
});

describe("Speichern und Versand", () => {
  it("legt sortiert ab, schickt Fällige einmal, auch wenn der Versand erst beim zweiten Mal klappt", async () => {
    const { kv: store, store: map } = kv();
    await addReminder(store, new Date("2026-11-03T13:00:00Z"), "Makler");
    await addReminder(store, new Date("2026-11-03T09:00:00Z"), "Bewerbung");
    expect((await listReminders(store)).map((r) => r.text)).toEqual(["Bewerbung", "Makler"]);

    const send = vi.fn().mockRejectedValueOnce(new Error("Telegram HTTP 502")).mockResolvedValue(undefined);
    expect(await sendDue(store, new Date("2026-11-03T10:00:00Z"), send)).toBe(0);
    expect(await sendDue(store, new Date("2026-11-03T10:05:00Z"), send)).toBe(1);
    expect(send).toHaveBeenLastCalledWith("⏰ Bewerbung");
    expect(await sendDue(store, new Date("2026-11-03T10:10:00Z"), send)).toBe(0);
    expect(map.size).toBe(1);
  });
});
