// Google: Zugriffstoken aus dem Refresh-Token, Drive-Ablage (nur eigene Dateien, drive.file) und Termine im
// Hauptkalender (der Code schreibt nur in „primary“, Entscheidung 42).

import type { Env } from "./env";

let cached: { token: string; expires: number } | null = null;

export async function accessToken(env: Env): Promise<string> {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
      refresh_token: env.GOOGLE_REFRESH_TOKEN ?? "",
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new GoogleError(`Google-Anmeldung fehlgeschlagen (HTTP ${res.status})`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

export class GoogleError extends Error {}

// Google liefert im Fehlerfall einen Grund wie „accessNotConfigured“ (API nicht aktiviert) – nur der kommt ins Log.
async function failure(what: string, res: Response): Promise<GoogleError> {
  let reason = "";
  try {
    const body = (await res.json()) as { error?: { status?: string; errors?: { reason?: string }[] } };
    reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? "";
  } catch {}
  console.log(`${what}: HTTP ${res.status} ${reason}`);
  return new GoogleError(`${what} HTTP ${res.status}${reason ? ` (${reason})` : ""}`);
}

export function googleReady(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN && env.DRIVE_ROOT_ID);
}

// ---------- Drive ----------

const FOLDER = "application/vnd.google-apps.folder";
const SEGMENT = /^[A-Za-zÄÖÜäöüß0-9][A-Za-zÄÖÜäöüß0-9 ._-]{0,39}$/;

export function checkFolder(path: string): string[] | null {
  const parts = path.split("/").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 3 || !parts.every((p) => SEGMENT.test(p) && !p.includes(".."))) return null;
  return parts;
}

export function checkFileName(name: string, originalName: string): string | null {
  const n = name.trim();
  if (n.length < 3 || n.length > 120 || /[\/\\:*?"<>|\r\n]/.test(n) || n.startsWith(".")) return null;
  const ext = /\.[A-Za-z0-9]{1,5}$/.exec(originalName)?.[0] ?? "";
  return ext && !n.toLowerCase().endsWith(ext.toLowerCase()) ? n + ext : n;
}

async function drive(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken(env);
  const res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
  if (!res.ok) throw await failure("Drive", res);
  return res;
}

async function ensureFolder(env: Env, parts: string[]): Promise<string> {
  let parent = env.DRIVE_ROOT_ID!;
  for (const name of parts) {
    const q = `name = '${name.replace(/'/g, "\\'")}' and '${parent}' in parents and mimeType = '${FOLDER}' and trashed = false`;
    const found = (await (await drive(env, `https://www.googleapis.com/drive/v3/files?fields=files(id)&q=${encodeURIComponent(q)}`)).json()) as {
      files: { id: string }[];
    };
    if (found.files.length) {
      parent = found.files[0].id;
      continue;
    }
    const created = (await (
      await drive(env, "https://www.googleapis.com/drive/v3/files?fields=id", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }),
      })
    ).json()) as { id: string };
    parent = created.id;
  }
  return parent;
}

export interface Saved {
  name: string;
  folder: string;
  link: string;
}

export async function saveToDrive(env: Env, folderParts: string[], name: string, mime: string, bytes: Uint8Array): Promise<Saved> {
  const parent = await ensureFolder(env, folderParts);
  const boundary = `b${crypto.randomUUID()}`;
  const meta = JSON.stringify({ name, parents: [parent] });
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  const res = await drive(env, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  const file = (await res.json()) as { id: string; webViewLink: string };
  console.log(`Drive: Datei abgelegt in ${folderParts.join("/")}`); // ohne Namen (R7)
  return { name, folder: folderParts.join("/"), link: file.webViewLink };
}

// ---------- Kalender ----------

export interface EventInput {
  title: string;
  date: string; // JJJJ-MM-TT
  start?: string; // HH:MM, fehlt = ganztägig
  end?: string; // HH:MM
  location?: string;
}

export type CheckedEvent = { ok: true; body: Record<string, unknown>; label: string } | { ok: false; error: string };

export function checkEvent(e: EventInput, today: string): CheckedEvent {
  const title = (e.title ?? "").trim();
  if (title.length < 2 || title.length > 120 || /[\r\n]/.test(title)) return { ok: false, error: "Titel 2–120 Zeichen, eine Zeile." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date ?? "") || Number.isNaN(Date.parse(e.date))) return { ok: false, error: "Datum als JJJJ-MM-TT." };
  if (e.date < today) return { ok: false, error: "Datum liegt in der Vergangenheit." };
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (e.start !== undefined && !hhmm.test(e.start)) return { ok: false, error: "Beginn als HH:MM." };
  if (e.end !== undefined && (!e.start || !hhmm.test(e.end) || e.end <= e.start)) return { ok: false, error: "Ende als HH:MM nach dem Beginn." };
  const location = e.location?.trim().slice(0, 200) || undefined;
  const tz = "Europe/Berlin";
  if (!e.start) {
    const next = new Date(`${e.date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return {
      ok: true,
      body: { summary: title, location, start: { date: e.date }, end: { date: next.toISOString().slice(0, 10) } },
      label: `${title}, ${e.date} (ganztägig)`,
    };
  }
  const end = e.end ?? addHour(e.start);
  return {
    ok: true,
    body: { summary: title, location, start: { dateTime: `${e.date}T${e.start}:00`, timeZone: tz }, end: { dateTime: `${e.date}T${end}:00`, timeZone: tz } },
    label: `${title}, ${e.date} ${e.start}–${end}`,
  };
}

function addHour(hhmm: string): string {
  const h = Number(hhmm.slice(0, 2));
  return h >= 23 ? "23:59" : `${String(h + 1).padStart(2, "0")}:${hhmm.slice(3)}`;
}

export async function insertEvent(env: Env, body: Record<string, unknown>): Promise<void> {
  const token = await accessToken(env);
  const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure("Kalender", res);
  console.log("Kalender: Termin eingetragen");
}

// Nur lesend: prüft Anmeldung, Kalender, Ablage-Ordner und Gmail. Für /check.
export async function checkGoogle(env: Env): Promise<string[]> {
  const lines: string[] = [];
  let token: string;
  try {
    token = await accessToken(env);
    lines.push("Anmeldung: ok");
  } catch (e) {
    return [`Anmeldung: ${e instanceof Error ? e.message : "Fehler"}`];
  }
  const probes: [string, string][] = [
    // Termine lesen statt Kalender-Metadaten: calendar.events deckt nur Termine ab, calendars.get gibt 403.
    ["Kalender", "https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1&fields=kind"],
    ["Drive-Ablage", `https://www.googleapis.com/drive/v3/files/${env.DRIVE_ROOT_ID}?fields=id`],
    ["Gmail (lesen)", "https://gmail.googleapis.com/gmail/v1/users/me/profile"],
  ];
  for (const [what, url] of probes) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    lines.push(res.ok ? `${what}: ok` : `${(await failure(what, res)).message}`);
  }
  return lines;
}
