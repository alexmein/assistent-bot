// Erfassen: hängt genau eine Zeile an einen erlaubten Abschnitt an. Ändern, Verschieben oder Löschen ist
// hier nicht möglich – der Code prüft vor jedem Schreiben, dass sich die Datei nur um diese eine Zeile ändert.

import type { Env } from "./env";

const TODO_SECTIONS = ["### Aktiv", "### Wartet auf andere", "### Geparkt"];

// Datei → erlaubte Abschnitte (Überschrift exakt wie in der Datei).
export function allowedSections(path: string): string[] | null {
  if (/^bereiche\/[a-z0-9][a-z0-9-]*\.md$/.test(path)) return [...TODO_SECTIONS, "## Verweise"];
  if (path === "docs/eingang.md") return ["## Unzugeordnet", "## Vorschläge für neue Bereiche", "## Auffälligkeiten"];
  if (path === "docs/status.md") return ["## Kritisch / dringend", "## Fristen (nächste 30 Tage)", "## → am Mac"];
  return null;
}

export type Checked = { ok: true; line: string } | { ok: false; error: string };

// Prüft und vervollständigt die Zeile. `date` ist JJJJ-MM-TT (Europe/Berlin).
export function checkLine(path: string, section: string, raw: string, date: string): Checked {
  const sections = allowedSections(path);
  if (!sections) return { ok: false, error: "Datei nicht erlaubt." };
  if (!sections.includes(section)) return { ok: false, error: `Abschnitt nicht erlaubt. Erlaubt: ${sections.join(" | ")}` };
  const line = raw.trim();
  if (/[\r\n]/.test(line)) return { ok: false, error: "Nur eine Zeile." };
  if (line.length < 5 || line.length > 400) return { ok: false, error: "Zeile muss 5–400 Zeichen lang sein." };
  if (!line.startsWith("- ")) return { ok: false, error: "Zeile muss mit „- “ beginnen." };
  if (/^- \[[xX]\]/.test(line)) return { ok: false, error: "Erledigt markieren darf nur Alex." };
  if (TODO_SECTIONS.includes(section) && !line.startsWith("- [ ] ")) {
    return { ok: false, error: "To-dos beginnen mit „- [ ] “." };
  }
  if (/\[A~?\]/.test(line)) return { ok: false, error: "[A] und [A~] setzt nur Alex am Mac; nutze [P] oder [F]." };
  // R7: keine Konto-, Ausweis-, Vertrags- oder Steuernummern. IBAN-Muster oder eine Zifferngruppe ab 10 Stellen,
  // die nicht mit 0 oder + beginnt (Telefonnummern bleiben erlaubt).
  if (/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/.test(line) || /(?<![\d+][ ./-]?)[1-9](?:[ ./-]?\d){9,}/.test(line)) {
    return { ok: false, error: "Sieht nach einer Konto-, Vertrags- oder Ausweisnummer aus – die gehört nicht ins Repo (R7)." };
  }
  const source = `Telegram ${date}`;
  return { ok: true, line: line.includes(source) ? line : `${line} · ${source}` };
}

// Fügt `line` am Ende des Abschnitts ein (vor der nächsten Überschrift, nach dem letzten nicht-leeren Inhalt).
export function insertLine(content: string, section: string, line: string): string | null {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === section);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6} /.test(lines[i])) {
      end = i;
      break;
    }
  }
  let at = end;
  while (at > start + 1 && lines[at - 1].trim() === "") at--;
  const next = [...lines.slice(0, at), line, ...lines.slice(at)];
  return onlyAdded(lines, next, line) ? next.join("\n") : null;
}

// Gegenprobe: neue Fassung = alte Fassung plus genau diese eine Zeile.
export function onlyAdded(before: string[], after: string[], line: string): boolean {
  if (after.length !== before.length + 1) return false;
  const i = after.findIndex((l, k) => l !== before[k]);
  return i !== -1 && after[i] === line && after.slice(i + 1).every((l, k) => l === before[i + k]);
}

export type AppendResult = { ok: true; path: string; section: string; line: string } | { ok: false; error: string };

const API = "https://api.github.com";

function headers(env: Env): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "assistent-bot",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function appendEntry(env: Env, path: string, section: string, line: string): Promise<AppendResult> {
  const url = `${API}/repos/${env.GITHUB_REPO}/contents/${path}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const get = await fetch(url, { headers: headers(env) });
    if (get.status === 404) return { ok: false, error: "Datei existiert nicht." };
    if (!get.ok) return { ok: false, error: `GitHub HTTP ${get.status}` };
    const file = (await get.json()) as { content: string; sha: string };
    const next = insertLine(decodeBase64(file.content), section, line);
    if (next === null) return { ok: false, error: `Abschnitt „${section}“ fehlt in ${path}. Nimm docs/eingang.md › ## Unzugeordnet.` };

    const short = line.replace(/^- (\[ \] )?/, "").slice(0, 60);
    const put = await fetch(url, {
      method: "PUT",
      headers: { ...headers(env), "Content-Type": "application/json" },
      body: JSON.stringify({ message: `${path}: ${short} (via Telegram)`, content: encodeBase64(next), sha: file.sha }),
    });
    if (put.ok) {
      console.log(`Angehängt: ${path} ${section}`); // ohne Inhalt (R7); der Inhalt steht im Commit
      return { ok: true, path, section, line };
    }
    // 409: Datei hat sich zwischen Lesen und Schreiben geändert (z. B. Push vom Mac) → einmal neu versuchen.
    if (put.status !== 409 || attempt === 2) return { ok: false, error: `GitHub HTTP ${put.status} beim Schreiben` };
  }
  return { ok: false, error: "Schreiben fehlgeschlagen." };
}

function decodeBase64(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function encodeBase64(text: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}
