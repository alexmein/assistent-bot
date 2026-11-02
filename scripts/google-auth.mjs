#!/usr/bin/env node
// Schritt 6: Google-Freigabe für das Workspace-Konto holen und als Secrets ablegen.
// Client-ID und -Secret werden verdeckt abgefragt; das Refresh-Token geht direkt an wrangler und wird nie angezeigt.
// Legt außerdem den Drive-Ordner „Assistent-Ablage“ an und gibt dessen ID aus (keine geheime Angabe).

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.file", // nur Dateien, die der Bot selbst anlegt
  "https://www.googleapis.com/auth/calendar.events", // Termine; der Code schreibt nur in den Hauptkalender
  "https://www.googleapis.com/auth/gmail.readonly", // Schritt 7, nur lesen
];

function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) rl.output.write(prompt); };
    rl.question(prompt, (v) => { rl.close(); process.stdout.write("\n"); resolve(v.trim()); });
  });
}

function putSecret(name, value) {
  return new Promise((resolve, reject) => {
    const p = spawn("npx", ["wrangler", "secret", "put", name], { stdio: ["pipe", "ignore", "inherit"] });
    p.stdin.end(value);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`wrangler secret put ${name} fehlgeschlagen`))));
  });
}

const clientId = await askHidden("Google Client-ID (unsichtbar): ");
const clientSecret = await askHidden("Google Client-Secret (unsichtbar): ");
if (!clientId.endsWith(".apps.googleusercontent.com") || !clientSecret) {
  console.error("Das sieht nicht nach einer Desktop-OAuth-Client-ID aus.");
  process.exit(1);
}

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(16).toString("hex");

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname !== "/callback") return res.writeHead(404).end();
    const ok = url.searchParams.get("state") === state && url.searchParams.get("code");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(ok ? "Freigabe erhalten. Du kannst dieses Fenster schließen." : "Freigabe fehlgeschlagen.");
    server.close();
    ok ? resolve(url.searchParams.get("code")) : reject(new Error(url.searchParams.get("error") ?? "state passt nicht"));
  });
  server.listen(0, "127.0.0.1", () => {
    const redirect = `http://127.0.0.1:${server.address().port}/callback`;
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirect,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    }).toString();
    console.log("→ Browser öffnet sich. Mit dem meinwiedein.com-Konto anmelden und zustimmen.");
    spawnSync("open", [auth.toString()]);
    globalThis.redirectUri = redirect;
  });
});

const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: globalThis.redirectUri,
  }),
});
const tokens = await tokenRes.json();
if (!tokenRes.ok || !tokens.refresh_token) {
  console.error(`Token-Tausch fehlgeschlagen (HTTP ${tokenRes.status}${tokens.error ? `, ${tokens.error}` : ""}).`);
  process.exit(1);
}
const granted = (tokens.scope ?? "").split(" ");
const missing = SCOPES.filter((s) => !granted.includes(s));
if (missing.length) console.log(`Achtung, nicht freigegeben: ${missing.join(", ")}`);

console.log("→ Secrets setzen …");
await putSecret("GOOGLE_CLIENT_ID", clientId);
await putSecret("GOOGLE_CLIENT_SECRET", clientSecret);
await putSecret("GOOGLE_REFRESH_TOKEN", tokens.refresh_token);

const auth = { Authorization: `Bearer ${tokens.access_token}` };
const cal = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1&fields=timeZone", { headers: auth });
const calInfo = await cal.json();
console.log(cal.ok ? `→ Kalender erreichbar: Zeitzone ${calInfo.timeZone}` : `Kalender nicht erreichbar (HTTP ${cal.status})`);

const folder = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Assistent-Ablage", mimeType: "application/vnd.google-apps.folder" }),
});
const folderInfo = await folder.json();
if (!folder.ok) {
  console.error(`Ablage-Ordner nicht angelegt (HTTP ${folder.status}).`);
  process.exit(1);
}
const tomlPath = new URL("../wrangler.toml", import.meta.url);
const toml = readFileSync(tomlPath, "utf8");
writeFileSync(tomlPath, toml.replace(/^DRIVE_ROOT_ID = "[^"]*".*$/m, `DRIVE_ROOT_ID = "${folderInfo.id}"`));
console.log("→ Drive-Ordner „Assistent-Ablage“ angelegt, ID in wrangler.toml eingetragen.");
console.log("Fertig. Sag Claude Bescheid – der Bot wird dann neu veröffentlicht.");
