// Feiertage und Schulferien Bayern fürs Tagesbriefing (Entscheidung 48). Gesetzliche Feiertage werden berechnet
// (Art. 1 Feiertagsgesetz Bayern), Schulferien stehen mit Quelle in docs/kalender.md.

import { addDays, shortDate } from "./briefing";

export interface Period {
  start: string;
  end: string;
  name: string;
}

// Ostersonntag (gregorianisch, Algorithmus nach Meeus/Jones/Butcher).
export function easter(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function holidays(year: number): Period[] {
  const e = easter(year);
  const day = (date: string, name: string): Period => ({ start: date, end: date, name });
  const fixed = (md: string, name: string) => day(`${year}-${md}`, name);
  return [
    fixed("01-01", "Neujahr"),
    fixed("01-06", "Heilige Drei Könige"),
    day(addDays(e, -2), "Karfreitag"),
    day(addDays(e, 1), "Ostermontag"),
    fixed("05-01", "Tag der Arbeit"),
    day(addDays(e, 39), "Christi Himmelfahrt"),
    day(addDays(e, 50), "Pfingstmontag"),
    day(addDays(e, 60), "Fronleichnam"),
    fixed("08-15", "Mariä Himmelfahrt (in überwiegend katholischen Gemeinden)"),
    fixed("10-03", "Tag der Deutschen Einheit"),
    fixed("11-01", "Allerheiligen"),
    fixed("12-25", "1. Weihnachtstag"),
    fixed("12-26", "2. Weihnachtstag"),
  ].map((p) => ({ ...p, name: `Feiertag: ${p.name}` }));
}

// Zeilen „- JJJJ-MM-TT bis JJJJ-MM-TT: Name“ bzw. „- JJJJ-MM-TT: Name“ aus docs/kalender.md.
export function parsePeriods(text: string): Period[] {
  const out: Period[] = [];
  for (const line of text.split("\n")) {
    const m = /^- (\d{4}-\d{2}-\d{2})(?: bis (\d{4}-\d{2}-\d{2}))?: (.+)$/.exec(line.trim());
    if (m) out.push({ start: m[1], end: m[2] ?? m[1], name: m[3].trim() });
  }
  return out;
}

// Heute Laufendes und was in den nächsten 7 Tagen beginnt.
export function calendarLines(today: string, periods: Period[]): string[] {
  const week = addDays(today, 7);
  const lines: string[] = [];
  for (const p of [...periods].sort((a, b) => a.start.localeCompare(b.start))) {
    if (p.start <= today && today <= p.end) {
      lines.push(p.start === p.end ? `- Heute: ${p.name}` : `- Läuft: ${p.name} (bis ${shortDate(p.end)})`);
    } else if (p.start > today && p.start <= week) {
      lines.push(`- ${shortDate(p.start)}: ${p.name}${p.end !== p.start ? ` (bis ${shortDate(p.end)})` : ""}`);
    }
  }
  return lines;
}

export function periodsFor(today: string, kalender: string): Period[] {
  const year = Number(today.slice(0, 4));
  return [...holidays(year), ...holidays(year + 1), ...parsePeriods(kalender)];
}
