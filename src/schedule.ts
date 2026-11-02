// Zeitgerüst (Phase 3 Schritt 1): Cloudflare-Cron läuft in UTC alle 15 Minuten. Hier wird in Berliner Zeit
// gerechnet (Sommer/Winter), Ruhezeiten geprüft (CLAUDE.md §3) und jeder Lauf pro Tag genau einmal ausgeführt.

export type Weekday = "Mon" | "Tue" | "Wed" | "Thu" | "Fri" | "Sat" | "Sun";

export interface LocalTime {
  date: string; // JJJJ-MM-TT
  weekday: Weekday;
  minutes: number; // seit Mitternacht
}

export function berlin(now: Date): LocalTime {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday as Weekday,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

// Ruhezeiten (CLAUDE.md §3): täglich 0–8 Uhr, Sa/So bis 10:30, Montag ab 13 Uhr.
export function quietTime(now: Date): boolean {
  const t = berlin(now);
  if (t.minutes < 8 * 60) return true;
  if ((t.weekday === "Sat" || t.weekday === "Sun") && t.minutes < 10 * 60 + 30) return true;
  return t.weekday === "Mon" && t.minutes >= 13 * 60;
}

export const hm = (h: number, m = 0) => h * 60 + m;

export interface Job {
  name: string;
  at: (weekday: Weekday) => number | null; // Startzeit in Minuten, null = an diesem Tag nicht
  run: () => Promise<void>;
  ignoresQuiet?: boolean; // ausdrücklich terminierte Erinnerungen gehen immer durch
}

const CATCH_UP = 120; // fällt ein Cron-Lauf aus, holt der nächste den Job bis 2 Std. später nach
const DONE_TTL = 3 * 24 * 3600;

// Führt fällige Jobs aus. Als erledigt gilt ein Job erst nach Erfolg; scheitert er, versucht es der nächste Lauf.
export async function runDue(jobs: Job[], now: Date, state: Pick<KVNamespace, "get" | "put">): Promise<string[]> {
  const t = berlin(now);
  const ran: string[] = [];
  for (const job of jobs) {
    const at = job.at(t.weekday);
    if (at === null || t.minutes < at || t.minutes >= at + CATCH_UP) continue;
    if (!job.ignoresQuiet && quietTime(now)) continue;
    const key = `job:${job.name}:${t.date}`;
    if (await state.get(key)) continue;
    try {
      await job.run();
      await state.put(key, "done", { expirationTtl: DONE_TTL });
      ran.push(job.name);
      console.log(`Job ${job.name}: ok`);
    } catch (e) {
      console.log(`Job ${job.name}: fehlgeschlagen (${e instanceof Error ? e.name : "Fehler"})`);
    }
  }
  return ran;
}

// „HH:MM“ → Minuten; für die Probe in Schritt 1 (Variable PROBE_AT).
export function parseHm(s: string | undefined): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s ?? "");
  return m ? hm(Number(m[1]), Number(m[2])) : null;
}
