// Push-Erinnerungen (Phase 3 Schritt 3, Entscheidung 27): nur auf Alex' Wunsch. Gespeichert im KV STATE (kein
// Repo-Wissen, nur ein Wecker); der Cron (alle 5 Minuten) schickt fällige – auch in Ruhezeiten, weil sie
// ausdrücklich terminiert sind (Entscheidung 28).

import { shortDate } from "./briefing";

const PREFIX = "reminder:";
const MAX_PENDING = 50;

export interface Reminder {
  id: string; // KV-Schlüssel
  at: string; // UTC, ISO
  text: string;
}

type Store = Pick<KVNamespace, "put" | "delete" | "list">;

// „JJJJ-MM-TT HH:MM“ Berliner Zeit → UTC. Sommer-/Winterzeit über den Versatz zu dieser Uhrzeit.
export function berlinToUtc(date: string, time: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const naive = new Date(`${date}T${time}:00Z`);
  if (Number.isNaN(naive.getTime())) return null;
  for (const offset of [1, 2]) {
    const guess = new Date(naive.getTime() - offset * 3600_000);
    const shown = guess.toLocaleString("sv-SE", { timeZone: "Europe/Berlin" }).slice(0, 16).replace(" ", "T");
    if (shown === `${date}T${time}`) return guess;
  }
  return null; // Uhrzeit fällt in die Zeitumstellung
}

export function label(at: Date): string {
  const day = at.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  const time = at.toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" });
  return `${shortDate(day)} ${time}`;
}

export type Checked = { ok: true; at: Date; text: string } | { ok: false; error: string };

export function checkReminder(input: { date?: unknown; time?: unknown; text?: unknown }, now: Date): Checked {
  if (typeof input.date !== "string" || typeof input.time !== "string") return { ok: false, error: "date (JJJJ-MM-TT) und time (HH:MM) angeben." };
  const text = typeof input.text === "string" ? input.text.replace(/\s+/g, " ").trim() : "";
  if (text.length < 2 || text.length > 200) return { ok: false, error: "text: 2–200 Zeichen." };
  const at = berlinToUtc(input.date, input.time);
  if (!at) return { ok: false, error: "Datum/Uhrzeit ungültig." };
  if (at.getTime() < now.getTime() + 60_000) return { ok: false, error: "Zeitpunkt liegt in der Vergangenheit." };
  if (at.getTime() > now.getTime() + 366 * 86_400_000) return { ok: false, error: "Höchstens ein Jahr im Voraus." };
  return { ok: true, at, text };
}

export async function listReminders(store: Store): Promise<Reminder[]> {
  const res = await store.list<{ text: string; at: string }>({ prefix: PREFIX });
  return res.keys
    .filter((k) => k.metadata)
    .map((k) => ({ id: k.name, at: k.metadata!.at, text: k.metadata!.text }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

export async function addReminder(store: Store, at: Date, text: string): Promise<Reminder> {
  if ((await listReminders(store)).length >= MAX_PENDING) throw new ReminderError(`Schon ${MAX_PENDING} offene Erinnerungen.`);
  // Schlüssel sortiert nach Zeit; Inhalt in den Metadaten, damit list() ohne weitere Abrufe reicht.
  const id = `${PREFIX}${String(at.getTime()).padStart(14, "0")}:${crypto.randomUUID().slice(0, 8)}`;
  const reminder = { id, at: at.toISOString(), text };
  await store.put(id, "", { metadata: { at: reminder.at, text }, expirationTtl: Math.max(60, Math.ceil((at.getTime() - Date.now()) / 1000) + 7 * 86_400) });
  return reminder;
}

export class ReminderError extends Error {}

// Fällige verschicken; nur nach erfolgreichem Versand löschen (sonst nächster Lauf).
export async function sendDue(store: Store, now: Date, send: (text: string) => Promise<void>): Promise<number> {
  let sent = 0;
  for (const r of await listReminders(store)) {
    if (r.at > now.toISOString()) break;
    try {
      await send(`⏰ ${r.text}`);
      await store.delete(r.id);
      sent++;
    } catch (e) {
      console.log(`Erinnerung nicht gesendet (${e instanceof Error ? e.message : "Fehler"})`);
    }
  }
  return sent;
}
