// Tagesbriefing (Phase 3 Schritt 2, Entscheidung 25): 8:30, Sa/So 10:30. Alles kommt aus dem Code: fällige To-dos,
// Fristen ≤ 7 Tage, neue Commits seit dem letzten Briefing, neue Auffälligkeiten – ohne Modell. Ein Modell hatte im
// ersten Test ganze Abschnitte weggelassen; eine Liste braucht kein Urteil, und so kann nichts fehlen oder erfunden sein (R2).

import type { FileResult } from "./github";
import { BEREICHE } from "./mail";

const TUTZING = { latitude: 47.909, longitude: 11.28 }; // Open-Meteo-Ortssuche „Tutzing“, 2026-11-02

export interface DatedLine {
  file: string;
  line: string;
  date: string; // JJJJ-MM-TT
  prio: "kritisch" | "dringend" | "standard" | "";
}

// Offene To-dos („- [ ] …“) überall, dazu die Zeilen unter „## Fristen“ im Dashboard. Datum: „fällig JJJJ-MM-TT“,
// sonst Zeilenanfang „- JJJJ-MM-TT“ (Fristen) oder „Frist TT.MM.JJJJ“.
export function datedLines(file: string, text: string): DatedLine[] {
  const found: DatedLine[] = [];
  let section = "";
  for (const raw of text.split("\n")) {
    if (/^#{1,6} /.test(raw)) section = raw.trim();
    const line = raw.trim();
    const open = line.startsWith("- [ ] ");
    const frist = section.startsWith("## Fristen") && /^- \d{4}-\d{2}-\d{2}/.test(line);
    if (!open && !frist) continue;
    const date =
      /fällig (\d{4}-\d{2}-\d{2})/.exec(line)?.[1] ??
      /^- (\d{4}-\d{2}-\d{2})/.exec(line)?.[1] ??
      germanDate(/Frist (\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(line));
    if (!date) continue;
    const prio = (/\b(kritisch|dringend|standard)\b/.exec(line)?.[1] ?? "") as DatedLine["prio"];
    found.push({ file, line: line.slice(0, 300), date, prio });
  }
  return found;
}

function germanDate(m: RegExpExecArray | null): string | undefined {
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : undefined;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// Entscheidung 29: überfällige kritische bleiben bis zur Triage; kleinere erscheinen nur am Tag selbst.
export function selectDue(lines: DatedLine[], today: string) {
  const week = addDays(today, 7);
  return {
    heute: lines.filter((l) => l.date === today),
    ueberfaellig: lines.filter((l) => l.date < today && l.prio === "kritisch"),
    bald: lines.filter((l) => l.date > today && l.date <= week),
  };
}

// Neue Auffälligkeiten: Zeilen unter „## Auffälligkeiten“, deren Herkunftsdatum (Mail/Telegram JJJJ-MM-TT) ab `since` liegt.
export function newFindings(eingang: string, since: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const raw of eingang.split("\n")) {
    if (/^#{1,6} /.test(raw)) inSection = raw.trim() === "## Auffälligkeiten";
    else if (inSection && raw.startsWith("- ") && !raw.startsWith("- [?]")) { // [?] sind Rückfragen, keine Einflussnahme
      const date = /(?:Mail|Telegram) (\d{4}-\d{2}-\d{2})\s*$/.exec(raw.trim())?.[1] ?? /\b(\d{4}-\d{2}-\d{2})\b/.exec(raw)?.[1];
      if (date && date >= since) out.push(raw.trim().slice(0, 300));
    }
  }
  return out;
}

// Commits seit dem letzten Briefing, die von außen kamen (Mail, Telegram).
export function newItems(messages: string[]): string[] {
  return messages
    .map((m) => m.split("\n")[0])
    .filter((m) => /\(via (Mail|Telegram)\)$/.test(m))
    .map((m) => m.slice(0, 200));
}

// ---------- Darstellung ----------

const WEEKDAY = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

export function shortDate(date: string): string {
  return `${WEEKDAY[new Date(`${date}T12:00:00Z`).getUTCDay()]} ${date.slice(8, 10)}.${date.slice(5, 7)}.`;
}

// Kern einer Zeile: ohne Aufzählung, Häkchen, führendes Datum, Tags und Metadaten nach „ · “.
export function core(line: string): { text: string; where: string } {
  let text = line.replace(/^- (\[ \] )?/, "").replace(/^\d{4}-\d{2}-\d{2} \([^)]*\): /, "");
  let where = /→ `?bereiche\/([a-z0-9-]+)\.md/.exec(line)?.[1] ?? "";
  const hc = /^→ hc-system: /.test(text);
  if (hc) {
    text = text.replace(/^→ hc-system: /, "");
    where = "hc-system";
  }
  text = text.split(" · ")[0].replace(/`?\[(P|F|A~?|\?)\]`?/g, "").trim();
  return { text, where };
}

function where(l: DatedLine): string {
  const fromLine = core(l.line).where;
  if (fromLine) return fromLine;
  if (l.file.startsWith("bereiche/")) return l.file.replace(/^bereiche\/|\.md$/g, "");
  return l.file === "docs/eingang.md" ? "Eingang" : "Dashboard";
}

// Dieselbe Aufgabe steht oft im Bereich und im Dashboard: einmal nennen, die Bereichs-Fassung bevorzugen.
export function dedupe(lines: DatedLine[]): DatedLine[] {
  const key = (l: DatedLine) => `${l.date}|${core(l.line).text.toLowerCase().replace(/[^a-zäöüß0-9]/g, "").slice(0, 30)}`;
  const best = new Map<string, DatedLine>();
  for (const l of lines) {
    const k = key(l);
    const prev = best.get(k);
    if (!prev || (l.file.startsWith("bereiche/") && !prev.file.startsWith("bereiche/"))) best.set(k, l);
  }
  return [...best.values()].sort((a, b) => a.date.localeCompare(b.date) || rank(a) - rank(b));
}

const rank = (l: DatedLine) => ({ kritisch: 0, dringend: 1, standard: 2, "": 3 })[l.prio];

function item(l: DatedLine, withDate: boolean): string {
  const prio = l.prio ? ` · ${l.prio}` : "";
  return `- ${withDate ? `${shortDate(l.date)}: ` : ""}${core(l.line).text}${prio} (${where(l)})`;
}

export interface RepoLine {
  file: string;
  line: string;
}

// Commit-Nachricht „<pfad>: <Zeilenanfang, 60 Zeichen> (via …)“ → vollständige Zeile im Repo.
export function resolve(message: string, lines: RepoLine[]): RepoLine | null {
  const m = /^([^:]+\.md): (.*) \(via (?:Mail|Telegram)\)$/.exec(message);
  if (!m) return null;
  const [, file, short] = m;
  const strip = (l: string) => l.replace(/^- (\[ \] )?/, "");
  return lines.find((l) => l.file === file && strip(l.line).startsWith(short.trim())) ?? null;
}

export function newsLines(items: string[], lines: RepoLine[]): string[] {
  const mail = items.filter((m) => m.endsWith("(via Mail)")).length;
  const counts = [mail ? `${mail} per Mail` : "", items.length - mail ? `${items.length - mail} per Telegram` : ""].filter(Boolean).join(", ");
  const found = items.map((m) => resolve(m, lines)).filter((x): x is RepoLine => x !== null);
  const todos = new Map<string, string>();
  const docs: string[] = [];
  let inbox = 0;
  let questions = 0;
  for (const f of found) {
    if (/ – Drive: https:/.test(f.line)) docs.push(f.line.replace(/^- /, "").split(" – Drive:")[0]);
    else if (f.line.startsWith("- [ ] ")) {
      const c = core(f.line);
      const key = c.text.toLowerCase().replace(/[^a-zäöüß0-9]/g, "").slice(0, 30);
      const prio = /\b(kritisch|dringend|standard)\b/.exec(f.line)?.[1];
      const area = c.where || (f.file.startsWith("bereiche/") ? f.file.replace(/^bereiche\/|\.md$/g, "") : "Eingang");
      if (!todos.has(key)) todos.set(key, `- ${c.text}${prio ? ` · ${prio}` : ""} (${area})`);
    } else if (f.file === "docs/eingang.md" && !/versuchte Einflussnahme/.test(f.line)) {
      inbox++;
      if (f.line.startsWith("- [?]")) questions++;
    }
  }
  const out = [`${items.length} neue Einträge (${counts})`];
  if (todos.size) out.push(`To-dos (${todos.size}):`, ...[...todos.values()].slice(0, 8), ...(todos.size > 8 ? [`- … und ${todos.size - 8} weitere`] : []));
  if (docs.length) out.push(`In Drive (${docs.length}): ${docs.slice(0, 3).join("; ")}${docs.length > 3 ? " …" : ""}`);
  if (inbox) out.push(`Eingangskorb: ${inbox} neu${questions ? `, davon ${questions} Rückfragen [?]` : ""} → Triage`);
  return out;
}

function findingLine(f: string): string {
  return `- ${f.replace(/^- /, "").split(" · ")[0].slice(0, 200)}`;
}

// ---------- Wetter (Open-Meteo, CC BY 4.0 – Quelle wird genannt) ----------

const WMO: [number[], string][] = [
  [[0], "klar"],
  [[1, 2], "heiter bis wolkig"],
  [[3], "bedeckt"],
  [[45, 48], "Nebel"],
  [[51, 53, 55, 56, 57], "Nieselregen"],
  [[61, 63, 65, 66, 67], "Regen"],
  [[71, 73, 75, 77], "Schnee"],
  [[80, 81, 82], "Regenschauer"],
  [[85, 86], "Schneeschauer"],
  [[95, 96, 99], "Gewitter"],
];

const WET = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]);

// Open-Meteo meldete im Test „Regen“ bei 0 mm und 0 %: Niederschlag nur nennen, wenn auch welcher erwartet wird.
export function weatherText(d: { code: number; max: number; min: number; rain: number; sum: number }): string {
  const dry = WET.has(d.code) && d.sum < 0.1 && d.rain < 10;
  const sky = dry ? "bedeckt" : (WMO.find(([codes]) => codes.includes(d.code))?.[1] ?? "wechselhaft");
  const wet = d.sum >= 0.1 ? `, ${d.sum.toFixed(1).replace(".", ",")} mm Niederschlag (${Math.round(d.rain)} %)` : d.rain >= 10 ? `, Regenrisiko ${Math.round(d.rain)} %` : "";
  return `Tutzing: ${sky}, ${Math.round(d.min)}–${Math.round(d.max)} °C${wet} (Wetter: open-meteo.com)`;
}

export async function fetchWeather(fetcher: typeof fetch = fetch): Promise<string> {
  const params = new URLSearchParams({
    latitude: String(TUTZING.latitude),
    longitude: String(TUTZING.longitude),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
    timezone: "Europe/Berlin",
    forecast_days: "1",
  });
  try {
    const res = await fetcher(`https://api.open-meteo.com/v1/forecast?${params}`);
    if (!res.ok) return "Wetter: gerade nicht abrufbar.";
    const d = ((await res.json()) as { daily: Record<string, number[]> }).daily;
    return weatherText({
      code: d.weather_code[0],
      max: d.temperature_2m_max[0],
      min: d.temperature_2m_min[0],
      rain: d.precipitation_probability_max[0] ?? 0,
      sum: d.precipitation_sum?.[0] ?? 0,
    });
  } catch {
    return "Wetter: gerade nicht abrufbar.";
  }
}

// ---------- Zusammenbau ----------

export interface BriefingDeps {
  readFile: (path: string) => Promise<FileResult>;
  commitsSince: (iso: string) => Promise<string[]>; // Commit-Nachrichten
  weather: () => Promise<string>;
  now: () => Date;
}

export async function buildBriefing(deps: BriefingDeps, sinceIso: string): Promise<string> {
  const today = deps.now().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  const sinceDate = new Date(sinceIso).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
  const paths = ["docs/status.md", "docs/eingang.md", ...BEREICHE.map((b) => `bereiche/${b}.md`)];
  const [weather, commits, ...files] = await Promise.all([deps.weather(), deps.commitsSince(sinceIso), ...paths.map((p) => deps.readFile(p))]);

  const dated = paths.flatMap((p, i) => {
    const f = files[i];
    return f.ok ? datedLines(p, f.text) : [];
  });
  const due = selectDue(dated, today);
  const findings = newFindings(files[1].ok ? files[1].text : "", sinceDate);
  const items = newItems(commits);
  const unreadable = paths.filter((_, i) => !files[i].ok);

  const blocks: string[] = [];
  const add = (title: string, lines: string[]) => lines.length && blocks.push([title, ...lines].join("\n"));
  add("Heute fällig", dedupe(due.heute).map((l) => item(l, false)));
  add("Überfällig (kritisch)", dedupe(due.ueberfaellig).map((l) => item(l, true)));
  add("Fristen nächste 7 Tage", dedupe(due.bald).map((l) => item(l, true)));
  const repoLines: RepoLine[] = paths.flatMap((p, i) => {
    const f = files[i];
    return f.ok ? f.text.split("\n").filter((l) => l.startsWith("- ")).map((line) => ({ file: p, line: line.trim() })) : [];
  });
  add("Neu eingegangen", items.length ? newsLines(items, repoLines) : []);
  add("Auffälligkeiten", findings.map(findingLine));
  if (unreadable.length) blocks.push(`(Nicht lesbar: ${unreadable.join(", ")})`);

  const head = `${shortDate(today)} – ${weather}`;
  return blocks.length ? `${head}\n\n${blocks.join("\n\n")}` : `${head}\nNichts Neues.`;
}
