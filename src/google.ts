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
export async function failure(what: string, res: Response): Promise<GoogleError> {
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

const MULTIPART_MAX = 5 * 1024 * 1024; // darüber „resumable“ (Google: multipart nur für kleine Dateien)

export async function saveToDrive(env: Env, folderParts: string[], name: string, mime: string, bytes: Uint8Array): Promise<Saved> {
  const parent = await ensureFolder(env, folderParts);
  const meta = JSON.stringify({ name, parents: [parent] });
  const res = await (bytes.length > MULTIPART_MAX ? uploadResumable(env, meta, mime, bytes) : uploadMultipart(env, meta, mime, bytes));
  const file = (await res.json()) as { id: string; webViewLink: string };
  console.log(`Drive: Datei abgelegt in ${folderParts.join("/")}`); // ohne Namen (R7)
  return { name, folder: folderParts.join("/"), link: file.webViewLink };
}

function uploadMultipart(env: Env, meta: string, mime: string, bytes: Uint8Array): Promise<Response> {
  const boundary = `b${crypto.randomUUID()}`;
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + bytes.length + tail.length);
  body.set(head, 0);
  body.set(bytes, head.length);
  body.set(tail, head.length + bytes.length);
  return drive(env, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
}

// Große Dateien: Sitzung öffnen, dann alles in einem PUT (bis 25 MB passt in den Speicher des Workers).
async function uploadResumable(env: Env, meta: string, mime: string, bytes: Uint8Array): Promise<Response> {
  const start = await drive(env, "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": mime, "X-Upload-Content-Length": String(bytes.length) },
    body: meta,
  });
  const session = start.headers.get("Location");
  if (!session) throw new GoogleError("Drive: keine Upload-Sitzung erhalten");
  return drive(env, session, { method: "PUT", headers: { "Content-Type": mime }, body: bytes as Uint8Array<ArrayBuffer> });
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
  lines.push(await grantedScopes(token));
  return lines;
}

// Welche Rechte hat Google wirklich erteilt? Belegt für die Sicherheitsprüfung, dass der Bot keine Mails senden kann.
const SEND_SCOPES = ["https://mail.google.com/", "gmail.send", "gmail.compose", "gmail.modify", "gmail.insert"];

export async function grantedScopes(token: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/tokeninfo", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ access_token: token }),
  });
  if (!res.ok) return `Rechte: nicht prüfbar (HTTP ${res.status})`;
  const scopes = (((await res.json()) as { scope?: string }).scope ?? "").split(" ").filter(Boolean);
  const short = scopes.map((s) => s.replace("https://www.googleapis.com/auth/", ""));
  const send = scopes.some((s) => SEND_SCOPES.some((x) => s === x || s.endsWith(`/${x}`)));
  return `Rechte: ${short.join(", ") || "keine"} · Mail senden: ${send ? "JA – prüfen!" : "nein"}`;
}

// ---------- Gmail (nur lesen) ----------

async function gmail<T>(env: Env, path: string): Promise<T> {
  const token = await accessToken(env);
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw await failure("Gmail", res);
  return (await res.json()) as T;
}

export async function listMessages(env: Env, query: string): Promise<string[]> {
  const data = await gmail<{ messages?: { id: string }[] }>(env, `messages?maxResults=50&q=${encodeURIComponent(query)}`);
  return (data.messages ?? []).map((m) => m.id);
}

export function getMessage<T>(env: Env, id: string): Promise<T> {
  return gmail<T>(env, `messages/${encodeURIComponent(id)}?format=full`);
}

export async function getAttachment(env: Env, messageId: string, attachmentId: string): Promise<Uint8Array> {
  const data = await gmail<{ data: string }>(env, `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
  return Uint8Array.from(atob(data.data.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
}

// ---------- Dateien auf Anfrage (Schritt 9, Entscheidung 45) ----------
// Mit drive.readonly sieht der Bot das ganze Drive; der Code gibt nur Dateien unterhalb der Assistent-Ablage heraus.

export interface FoundFile {
  id: string;
  name: string;
  folder: string; // Pfad unterhalb der Ablage, "" = direkt darin
  modified: string; // JJJJ-MM-TT
}

const MAX_DEPTH = 6;
const MAX_SEND_BYTES = 45 * 1024 * 1024; // Telegram nimmt von Bots bis 50 MB

type DriveMeta = { id: string; name: string; mimeType?: string; size?: string; parents?: string[]; modifiedTime?: string };

// Pfad eines Ordners unterhalb der Ablage ("" = die Ablage selbst), null wenn er nicht darin liegt.
async function folderPath(env: Env, id: string | undefined, cache: Map<string, string | null>, depth = 0): Promise<string | null> {
  if (!id || depth > MAX_DEPTH) return null;
  if (id === env.DRIVE_ROOT_ID) return "";
  if (cache.has(id)) return cache.get(id)!;
  const meta = (await (await drive(env, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,parents`)).json()) as DriveMeta;
  const parent = await folderPath(env, meta.parents?.[0], cache, depth + 1);
  const path = parent === null ? null : [parent, meta.name].filter(Boolean).join("/");
  cache.set(id, path);
  return path;
}

export function driveSearchQuery(term: string): string {
  const t = term.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `trashed = false and mimeType != '${FOLDER}' and (name contains '${t}' or fullText contains '${t}')`;
}

export async function findFiles(env: Env, term: string): Promise<FoundFile[]> {
  const params = new URLSearchParams({
    q: driveSearchQuery(term),
    fields: "files(id,name,parents,modifiedTime)",
    pageSize: "25",
    orderBy: "modifiedTime desc",
  });
  const data = (await (await drive(env, `https://www.googleapis.com/drive/v3/files?${params}`)).json()) as { files?: DriveMeta[] };
  const cache = new Map<string, string | null>();
  const found: FoundFile[] = [];
  for (const f of data.files ?? []) {
    const folder = await folderPath(env, f.parents?.[0], cache);
    if (folder === null) continue;
    found.push({ id: f.id, name: f.name, folder, modified: (f.modifiedTime ?? "").slice(0, 10) });
    if (found.length >= 8) break;
  }
  return found;
}

export interface DriveDownload {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

// Lädt eine Datei – nur, wenn sie unterhalb der Ablage liegt. Google-Dokumente werden als PDF exportiert.
export async function downloadFile(env: Env, id: string): Promise<DriveDownload> {
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(id)) throw new GoogleError("Ungültige Datei-ID");
  const base = `https://www.googleapis.com/drive/v3/files/${id}`;
  const meta = (await (await drive(env, `${base}?fields=id,name,mimeType,size,parents`)).json()) as DriveMeta;
  if ((await folderPath(env, meta.parents?.[0], new Map())) === null) throw new GoogleError("Die Datei liegt nicht in der Assistent-Ablage.");
  if (meta.mimeType === FOLDER) throw new GoogleError("Das ist ein Ordner, keine Datei.");
  if (Number(meta.size ?? 0) > MAX_SEND_BYTES) throw new GoogleError("Die Datei ist größer als 45 MB – Telegram nimmt sie nicht.");
  const native = meta.mimeType?.startsWith("application/vnd.google-apps.");
  const res = await drive(env, native ? `${base}/export?mimeType=application%2Fpdf` : `${base}?alt=media`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_SEND_BYTES) throw new GoogleError("Die Datei ist größer als 45 MB – Telegram nimmt sie nicht.");
  return { name: native ? `${meta.name}.pdf` : meta.name, mime: native ? "application/pdf" : (meta.mimeType ?? "application/octet-stream"), bytes };
}

export interface CalendarItem {
  date: string; // JJJJ-MM-TT (Berliner Zeit)
  time: string | null; // HH:MM, null = ganztägig
  title: string;
}

// Termine im Hauptkalender (nur lesen) – fürs Wochenbriefing.
export async function listEvents(env: Env, fromIso: string, toIso: string): Promise<CalendarItem[]> {
  const token = await accessToken(env);
  const params = new URLSearchParams({ timeMin: fromIso, timeMax: toIso, singleEvents: "true", orderBy: "startTime", maxResults: "50", fields: "items(summary,start)" });
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw await failure("Kalender", res);
  const data = (await res.json()) as { items?: { summary?: string; start?: { date?: string; dateTime?: string } }[] };
  return (data.items ?? []).map((e) => {
    const dt = e.start?.dateTime ? new Date(e.start.dateTime) : null;
    return {
      date: dt ? dt.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }) : (e.start?.date ?? ""),
      time: dt ? dt.toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }) : null,
      title: (e.summary ?? "(ohne Titel)").slice(0, 120),
    };
  });
}
