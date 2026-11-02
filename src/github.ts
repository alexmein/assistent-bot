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
