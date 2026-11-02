import type { Env } from "./env";

export type FileResult = { ok: true; text: string } | { ok: false; status: number; error: string };

export async function readRepoFile(env: Env, path: string): Promise<FileResult> {
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
    headers: {
      Accept: "application/vnd.github.raw+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "assistent-bot",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    console.log(`GitHub ${path}: HTTP ${res.status}`);
    return { ok: false, status: res.status, error: `GitHub HTTP ${res.status}` };
  }
  return { ok: true, text: await res.text() };
}

// Commit-Nachrichten seit `sinceIso` (neueste zuerst, höchstens 100) – für „neu eingegangen“ im Briefing.
export async function commitMessagesSince(env: Env, sinceIso: string): Promise<string[]> {
  const params = new URLSearchParams({ since: sinceIso, per_page: "100" });
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/commits?${params}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "assistent-bot",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`GitHub Commits HTTP ${res.status}`);
  return ((await res.json()) as { commit: { message: string } }[]).map((c) => c.commit.message);
}

// Schreibt eine ganze Datei – nur für die Triage-Vorbereitung (triage/JJJJ-MM-TT.md). Alles andere im Repo ändert der
// Bot nur durch Anhängen (append.ts). Eine Vorbereitung vom selben Tag wird ersetzt; die alte Fassung bleibt in git.
export async function writeTriageFile(env: Env, path: string, text: string, message: string): Promise<void> {
  if (!/^triage\/\d{4}-\d{2}-\d{2}\.md$/.test(path)) throw new Error("Pfad nicht erlaubt");
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    "User-Agent": "assistent-bot",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const existing = await fetch(url, { headers });
  const sha = existing.ok ? ((await existing.json()) as { sha: string }).sha : undefined;
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  const put = await fetch(url, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: btoa(bin), ...(sha ? { sha } : {}) }),
  });
  if (!put.ok) throw new Error(`GitHub HTTP ${put.status} beim Schreiben von ${path}`);
}

// Lesen in beliebigen Repos mit eigenem Token (Meta-Prüfung: dieses Repo mit GITHUB_TOKEN, HC-Repos mit HC_GITHUB_TOKEN).
function ghHeaders(token: string, raw = false): HeadersInit {
  return {
    Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "assistent-bot",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function repoCommits(token: string, repo: string, sinceIso: string, path?: string): Promise<{ repo: string; when: string; message: string }[]> {
  const params = new URLSearchParams({ since: sinceIso, per_page: "100", ...(path ? { path } : {}) });
  const res = await fetch(`https://api.github.com/repos/${repo}/commits?${params}`, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`GitHub ${repo} Commits HTTP ${res.status}`);
  return ((await res.json()) as { commit: { message: string; author: { date: string } } }[]).map((c) => ({ repo, when: c.commit.author.date, message: c.commit.message }));
}

export async function repoFile(token: string, repo: string, path: string): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { headers: ghHeaders(token, true) });
  if (!res.ok) {
    console.log(`GitHub ${repo}/${path}: HTTP ${res.status}`);
    return null;
  }
  return res.text();
}
