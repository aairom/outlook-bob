import { app, BrowserWindow, ipcMain, shell } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as crypto from "crypto";
import { URL, URLSearchParams } from "url";
import * as dotenv from "dotenv";

// ── Load shared .env from project root ────────────────────────────────────────
const _envCandidates = [
  path.join(__dirname, "..", "..", ".env"),
  path.join(process.resourcesPath ?? "", ".env"),
  path.join(process.cwd(), ".env"),
];
for (const candidate of _envCandidates) {
  if (fs.existsSync(candidate)) { dotenv.config({ path: candidate }); break; }
}

// ── Config ────────────────────────────────────────────────────────────────────
const CLIENT_ID       = process.env.CLIENT_ID     ?? "14d82eec-204b-4c2f-b7e8-296a70dab67e";
const AUTHORITY       = "https://login.microsoftonline.com/common";
const SCOPES          = "Mail.Read offline_access";
const REDIRECT_URI    = process.env.REDIRECT_URI  ?? "http://localhost:8765";
const REDIRECT_PORT   = parseInt(new URL(REDIRECT_URI).port || "8765", 10);
const GRAPH_BASE      = "https://graph.microsoft.com/v1.0";
const EXCLUDED_DOMAIN = process.env.EXCLUDED_DOMAIN ?? ".ibm.com";
const LOGIN_HINT      = process.env.LOGIN_HINT ?? "";

function getTokenCacheFile(): string {
  return path.join(app.getPath("home"), ".cache", "extract_outlook_token_folder.json");
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface TokenCache {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope: string;
}

interface MailFolder {
  id: string;
  displayName: string;
  totalItemCount: number;
  childFolderCount: number;
  children?: MailFolder[];
}

interface Recipient {
  name: string;
  email: string;
  date: string;
}

export interface ExportParams {
  /** "recipients-csv" | "emails-csv" | "eml" | "json" */
  exportFormat: "recipients-csv" | "emails-csv" | "eml" | "json";
  includeFrom:            boolean;
  includeToCC:            boolean;
  includeSubject:         boolean;
  includeBodyText:        boolean;
  includeBodyHtml:        boolean;
  includeAttachmentsMeta: boolean;
  filterExcludedDomain:   boolean;
  /** Domain substring to exclude, e.g. ".ibm.com". Falls back to env EXCLUDED_DOMAIN. */
  excludedDomain:         string;
}

// ── Token cache ───────────────────────────────────────────────────────────────
function loadTokenCache(): TokenCache | null {
  try {
    if (fs.existsSync(getTokenCacheFile()))
      return JSON.parse(fs.readFileSync(getTokenCacheFile(), "utf-8")) as TokenCache;
  } catch { /* corrupt */ }
  return null;
}

function saveTokenCache(cache: TokenCache): void {
  fs.mkdirSync(path.dirname(getTokenCacheFile()), { recursive: true });
  fs.writeFileSync(getTokenCacheFile(), JSON.stringify(cache, null, 2), "utf-8");
}

function clearTokenCache(): void {
  try { if (fs.existsSync(getTokenCacheFile())) fs.unlinkSync(getTokenCacheFile()); } catch { /* ignore */ }
}

// ── PKCE helpers ──────────────────────────────────────────────────────────────
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function generateCodeVerifier(): string { return b64url(crypto.randomBytes(32)); }
function generateCodeChallenge(v: string): string {
  return b64url(crypto.createHash("sha256").update(v).digest());
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpsGet(urlStr: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "GET", headers },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => res.statusCode && res.statusCode >= 400
          ? reject(new Error(`HTTP ${res.statusCode}: ${data}`))
          : resolve(data));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function httpsPost(urlStr: string, body: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const buf = Buffer.from(body, "utf-8");
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "POST",
        headers: { ...headers, "Content-Length": buf.byteLength } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => res.statusCode && res.statusCode >= 400
          ? reject(new Error(`HTTP ${res.statusCode}: ${data}`))
          : resolve(data));
      }
    );
    req.on("error", reject);
    req.write(buf);
    req.end();
  });
}

// ── Token acquisition ─────────────────────────────────────────────────────────
async function refreshAccessToken(refreshToken: string): Promise<TokenCache> {
  const raw = await httpsPost(
    `${AUTHORITY}/oauth2/v2.0/token`,
    new URLSearchParams({ client_id: CLIENT_ID, grant_type: "refresh_token",
      refresh_token: refreshToken, scope: SCOPES }).toString(),
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  const json = JSON.parse(raw);
  if (!json.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(json)}`);
  const cache: TokenCache = {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? refreshToken,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000,
    scope: json.scope ?? SCOPES,
  };
  saveTokenCache(cache);
  return cache;
}

async function getAccessTokenSilent(): Promise<string | null> {
  const cache = loadTokenCache();
  if (!cache) return null;
  if (Date.now() < cache.expires_at) return cache.access_token;
  if (cache.refresh_token) {
    try { return (await refreshAccessToken(cache.refresh_token)).access_token; }
    catch { clearTokenCache(); return null; }
  }
  return null;
}

async function authenticateInteractive(onProgress: (msg: string) => void): Promise<string> {
  const verifier  = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state     = b64url(crypto.randomBytes(16));

  const authUrl = new URL(`${AUTHORITY}/oauth2/v2.0/authorize`);
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  if (LOGIN_HINT) authUrl.searchParams.set("login_hint", LOGIN_HINT);
  else            authUrl.searchParams.set("prompt", "select_account");

  onProgress("Opening browser for Microsoft authentication…");

  const { code, receivedState } = await new Promise<{ code: string; receivedState: string }>(
    (resolve, reject) => {
      let done = false;
      const server = http.createServer((req, res) => {
        if (!req.url) { res.writeHead(400); res.end(); return; }
        const cb     = new URL(req.url, REDIRECT_URI);
        const code   = cb.searchParams.get("code");
        const error  = cb.searchParams.get("error");
        const rState = cb.searchParams.get("state") ?? "";
        const html = code
          ? "<html><body><h2 style='font-family:sans-serif;color:#107c10;margin:48px auto;max-width:480px'>✅ Authentication successful. You can close this tab.</h2></body></html>"
          : "<html><body><h2 style='font-family:sans-serif;color:#d13438;margin:48px auto;max-width:480px'>❌ Authentication error. Return to the app.</h2></body></html>";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        server.close();
        if (!done) {
          done = true;
          code ? resolve({ code, receivedState: rState })
               : reject(new Error(cb.searchParams.get("error_description") ?? error ?? "Unknown OAuth error"));
        }
      });
      server.listen(REDIRECT_PORT, "localhost", () => shell.openExternal(authUrl.toString()));
      server.on("error", (e) => { if (!done) { done = true; reject(e); } });
      setTimeout(() => {
        if (!done) { done = true; server.close(); reject(new Error("Authentication timed out (2 minutes).")); }
      }, 120_000);
    }
  );

  if (receivedState !== state) throw new Error("OAuth state mismatch — possible CSRF.");
  onProgress("Exchanging authorization code for tokens…");

  const raw = await httpsPost(
    `${AUTHORITY}/oauth2/v2.0/token`,
    new URLSearchParams({ client_id: CLIENT_ID, grant_type: "authorization_code",
      code, redirect_uri: REDIRECT_URI, code_verifier: verifier, scope: SCOPES }).toString(),
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  const json = JSON.parse(raw);
  if (!json.access_token) throw new Error(`Token exchange failed: ${JSON.stringify(json)}`);

  const cache: TokenCache = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000,
    scope: json.scope ?? SCOPES,
  };
  saveTokenCache(cache);
  onProgress("Authenticated successfully.");
  return cache.access_token;
}

// ── Graph API helpers ─────────────────────────────────────────────────────────
async function graphGet(token: string, url: string): Promise<unknown> {
  return JSON.parse(await httpsGet(url, { Authorization: `Bearer ${token}`, Accept: "application/json" }));
}

// ── Build $select field list from export params ───────────────────────────────
function buildSelectFields(params: ExportParams): string {
  const fields = new Set<string>(["id", "sentDateTime"]);

  if (params.exportFormat === "recipients-csv") {
    fields.add("toRecipients");
    fields.add("ccRecipients");
    fields.add("from");
    return [...fields].join(",");
  }

  // All other formats
  if (params.includeFrom)    { fields.add("from"); }
  if (params.includeToCC)    { fields.add("toRecipients"); fields.add("ccRecipients"); }
  if (params.includeSubject) { fields.add("subject"); }
  if (params.includeBodyText || params.includeBodyHtml) { fields.add("body"); }
  if (params.includeAttachmentsMeta) { fields.add("hasAttachments"); }

  // EML always needs these extra fields for proper headers
  if (params.exportFormat === "eml") {
    fields.add("internetMessageId");
    fields.add("from");
    fields.add("toRecipients");
    fields.add("ccRecipients");
    fields.add("subject");
    fields.add("body");
  }

  return [...fields].join(",");
}

// ── List mail folders (recursive) ─────────────────────────────────────────────
async function listFoldersRecursive(token: string, parentId?: string): Promise<MailFolder[]> {
  const endpoint = parentId
    ? `${GRAPH_BASE}/me/mailFolders/${parentId}/childFolders?$select=id,displayName,totalItemCount,childFolderCount&$top=100`
    : `${GRAPH_BASE}/me/mailFolders?$select=id,displayName,totalItemCount,childFolderCount&$top=100&includeHiddenFolders=false`;

  const results: MailFolder[] = [];
  let url: string | null = endpoint;
  while (url) {
    const page = (await graphGet(token, url)) as { value: MailFolder[]; "@odata.nextLink"?: string };
    for (const folder of page.value) {
      const node: MailFolder = {
        id: folder.id, displayName: folder.displayName,
        totalItemCount: folder.totalItemCount ?? 0,
        childFolderCount: folder.childFolderCount ?? 0,
      };
      if (node.childFolderCount > 0)
        node.children = await listFoldersRecursive(token, node.id);
      results.push(node);
    }
    url = page["@odata.nextLink"] ?? null;
  }
  return results;
}

// ── Iterate messages in a folder ──────────────────────────────────────────────
async function* iterFolderMessages(
  token: string, folderId: string, since: string | undefined, selectFields: string
): AsyncGenerator<Record<string, unknown>> {
  let url: string | null =
    `${GRAPH_BASE}/me/mailFolders/${folderId}/messages` +
    `?$select=${encodeURIComponent(selectFields)}&$top=50&$orderby=sentDateTime%20desc` +
    (since ? `&$filter=sentDateTime%20ge%20${encodeURIComponent(since + "T00:00:00Z")}` : "");
  while (url) {
    const data = (await graphGet(token, url)) as Record<string, unknown>;
    for (const msg of (data["value"] as Record<string, unknown>[]) ?? []) yield msg;
    url = (data["@odata.nextLink"] as string | undefined) ?? null;
  }
}

// ── Fetch attachment metadata ─────────────────────────────────────────────────
async function fetchAttachmentsMeta(
  token: string, messageId: string
): Promise<Array<{ name: string; size: number; contentType: string }>> {
  try {
    const url = `${GRAPH_BASE}/me/messages/${messageId}/attachments?$select=name,size,contentType&$top=50`;
    const data = (await graphGet(token, url)) as { value: Array<Record<string, unknown>> };
    return (data.value ?? []).map((a) => ({
      name: String(a["name"] ?? ""), size: Number(a["size"] ?? 0),
      contentType: String(a["contentType"] ?? ""),
    }));
  } catch { return []; }
}

// ── Address helpers ───────────────────────────────────────────────────────────
function isExcluded(addr: string, domain: string): boolean {
  const d = (domain || EXCLUDED_DOMAIN).trim();
  return d.length > 0 && addr.toLowerCase().includes(d.toLowerCase());
}

function extractAddress(ea: Record<string, string>): { name: string; email: string } {
  const raw = (ea["address"] ?? "").trim();
  const rawName = (ea["name"] ?? "").trim();
  if (raw.includes("@"))     return { email: raw.toLowerCase(),    name: rawName || raw };
  if (rawName.includes("@")) return { email: rawName.toLowerCase(), name: raw || rawName };
  return { email: "", name: "" };
}

function recipientListStr(list: Array<Record<string, unknown>>): string {
  return list.map((r) => {
    const ea = (r["emailAddress"] as Record<string, string> | undefined) ?? {};
    const { name, email } = extractAddress(ea);
    return email ? (name && name !== email ? `"${name}" <${email}>` : email) : "";
  }).filter(Boolean).join("; ");
}

// ── Output directory ──────────────────────────────────────────────────────────
function getOutputDir(): string {
  const dir = app.isPackaged
    ? path.join(app.getPath("userData"), "output")
    : path.join(app.getAppPath(), "output");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").substring(0, 15);
}

// ── FORMAT: recipients-csv (original behaviour) ───────────────────────────────
async function runRecipientsExport(
  token: string, folders: MailFolder[], since: string | undefined,
  params: ExportParams, onProgress: (msg: string) => void
): Promise<{ filePath: string; count: number }> {
  const selectFields = buildSelectFields(params);
  const recipients = new Map<string, Recipient>();
  let total = 0;

  onProgress(`Scanning ${folders.length} folder(s) for recipients…`);
  for (const folder of folders) {
    onProgress(`📁 ${folder.displayName}…`);
    for await (const msg of iterFolderMessages(token, folder.id, since, selectFields)) {
      total++;
      if (total % 100 === 0)
        onProgress(`Processed ${total} emails — ${recipients.size} unique recipients so far…`);
      const sentDate = new Date((msg["sentDateTime"] as string | undefined) ?? "");
      for (const field of ["toRecipients", "ccRecipients"] as const) {
        for (const rec of (msg[field] as Array<Record<string, unknown>> | undefined) ?? []) {
          const ea = (rec["emailAddress"] as Record<string, string> | undefined) ?? {};
          const { name, email } = extractAddress(ea);
          if (!email) continue;
          if (params.filterExcludedDomain && isExcluded(email, params.excludedDomain)) continue;
          const existing = recipients.get(email);
          if (!existing || sentDate > new Date(existing.date))
            recipients.set(email, { name, email, date: sentDate.toISOString() });
        }
      }
    }
  }
  onProgress(`Scan complete: ${total} emails, ${recipients.size} unique recipients.`);
  if (recipients.size === 0) return { filePath: "", count: 0 };

  const sorted = [...recipients.values()].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const rows = sorted.map((r) => {
    const dt = new Date(r.date);
    const ds = dt.getTime() > 0 ? dt.toISOString().replace("T", " ").substring(0, 19) : "";
    return [esc(r.name), esc(r.email), esc(ds)].join(",");
  });
  const filePath = path.join(getOutputDir(), `recipients_${timestamp()}.csv`);
  fs.writeFileSync(filePath, "Name,Email,LastSent\n" + rows.join("\n"), "utf-8");
  return { filePath, count: recipients.size };
}

// ── FORMAT: emails-csv (one row per message) ──────────────────────────────────
async function runEmailsCsvExport(
  token: string, folders: MailFolder[], since: string | undefined,
  params: ExportParams, onProgress: (msg: string) => void
): Promise<{ filePath: string; count: number }> {
  const selectFields = buildSelectFields(params);
  const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
  const headers = ["messageId","sentDateTime","from","fromName","toRecipients",
                   "ccRecipients","subject","bodyText","bodyHtml","attachments","folder"];
  const rows: string[] = [];
  let total = 0;

  onProgress(`Scanning ${folders.length} folder(s) — full email CSV…`);
  for (const folder of folders) {
    onProgress(`📁 ${folder.displayName}…`);
    for await (const msg of iterFolderMessages(token, folder.id, since, selectFields)) {
      total++;
      if (total % 50 === 0) onProgress(`Fetched ${total} messages…`);

      const fromEa = ((msg["from"] as Record<string,unknown>|undefined)?.["emailAddress"] as Record<string,string>|undefined) ?? {};
      const { name: fromName, email: fromEmail } = extractAddress(fromEa);
      if (params.filterExcludedDomain && fromEmail && isExcluded(fromEmail, params.excludedDomain)) continue;

      const bodyObj = msg["body"] as Record<string,string> | undefined;
      const isHtml  = bodyObj?.["contentType"] === "html";
      const bodyContent = bodyObj?.["content"] ?? "";

      let attachmentsStr = "";
      if (params.includeAttachmentsMeta && msg["hasAttachments"]) {
        const atts = await fetchAttachmentsMeta(token, msg["id"] as string);
        attachmentsStr = JSON.stringify(atts);
      }

      rows.push([
        esc(String(msg["id"] ?? "")),
        esc(String(msg["sentDateTime"] ?? "")),
        esc(params.includeFrom    ? fromEmail  : ""),
        esc(params.includeFrom    ? fromName   : ""),
        esc(params.includeToCC    ? recipientListStr((msg["toRecipients"] as Array<Record<string,unknown>>|undefined) ?? []) : ""),
        esc(params.includeToCC    ? recipientListStr((msg["ccRecipients"] as Array<Record<string,unknown>>|undefined) ?? []) : ""),
        esc(params.includeSubject ? String(msg["subject"] ?? "") : ""),
        esc(params.includeBodyText && !isHtml ? bodyContent : ""),
        esc(params.includeBodyHtml && isHtml  ? bodyContent : ""),
        esc(params.includeAttachmentsMeta     ? attachmentsStr : ""),
        esc(folder.displayName),
      ].join(","));
    }
  }

  onProgress(`Done: ${rows.length} messages exported.`);
  if (rows.length === 0) return { filePath: "", count: 0 };

  const filePath = path.join(getOutputDir(), `emails_${timestamp()}.csv`);
  fs.writeFileSync(filePath, headers.join(",") + "\n" + rows.join("\n"), "utf-8");
  return { filePath, count: rows.length };
}

// ── FORMAT: JSON (array of message objects) ───────────────────────────────────
async function runJsonExport(
  token: string, folders: MailFolder[], since: string | undefined,
  params: ExportParams, onProgress: (msg: string) => void
): Promise<{ filePath: string; count: number }> {
  const selectFields = buildSelectFields(params);
  const records: object[] = [];
  let total = 0;

  onProgress(`Scanning ${folders.length} folder(s) — JSON export…`);
  for (const folder of folders) {
    onProgress(`📁 ${folder.displayName}…`);
    for await (const msg of iterFolderMessages(token, folder.id, since, selectFields)) {
      total++;
      if (total % 50 === 0) onProgress(`Fetched ${total} messages…`);

      const fromEa = ((msg["from"] as Record<string,unknown>|undefined)?.["emailAddress"] as Record<string,string>|undefined) ?? {};
      const { name: fromName, email: fromEmail } = extractAddress(fromEa);
      if (params.filterExcludedDomain && fromEmail && isExcluded(fromEmail, params.excludedDomain)) continue;

      const bodyObj = msg["body"] as Record<string,string> | undefined;
      const rec: Record<string, unknown> = {
        messageId:    msg["id"],
        sentDateTime: msg["sentDateTime"],
        folder:       folder.displayName,
      };
      if (params.includeFrom)    { rec["from"] = fromEmail; rec["fromName"] = fromName; }
      if (params.includeToCC) {
        rec["toRecipients"] = recipientListStr((msg["toRecipients"] as Array<Record<string,unknown>>|undefined) ?? []);
        rec["ccRecipients"] = recipientListStr((msg["ccRecipients"] as Array<Record<string,unknown>>|undefined) ?? []);
      }
      if (params.includeSubject)  rec["subject"]  = msg["subject"];
      if (params.includeBodyText) rec["bodyText"]  = bodyObj?.["contentType"] !== "html" ? (bodyObj?.["content"] ?? "") : "";
      if (params.includeBodyHtml) rec["bodyHtml"]  = bodyObj?.["contentType"] === "html"  ? (bodyObj?.["content"] ?? "") : "";
      if (params.includeAttachmentsMeta && msg["hasAttachments"])
        rec["attachments"] = await fetchAttachmentsMeta(token, msg["id"] as string);

      records.push(rec);
    }
  }

  onProgress(`Done: ${records.length} messages exported.`);
  if (records.length === 0) return { filePath: "", count: 0 };

  const filePath = path.join(getOutputDir(), `emails_${timestamp()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(records, null, 2), "utf-8");
  return { filePath, count: records.length };
}

// ── FORMAT: EML (one .eml file per message) ───────────────────────────────────
function buildEml(msg: Record<string, unknown>, folderName: string): string {
  const fromEa = ((msg["from"] as Record<string,unknown>|undefined)?.["emailAddress"] as Record<string,string>|undefined) ?? {};
  const { name: fromName, email: fromEmail } = extractAddress(fromEa);
  const fromHeader = fromName && fromName !== fromEmail
    ? `"${fromName}" <${fromEmail}>` : (fromEmail || "unknown@unknown");
  const toStr  = recipientListStr((msg["toRecipients"] as Array<Record<string,unknown>>|undefined) ?? []);
  const ccStr  = recipientListStr((msg["ccRecipients"] as Array<Record<string,unknown>>|undefined) ?? []);
  const subject = String(msg["subject"] ?? "(no subject)");
  const date    = String(msg["sentDateTime"] ?? "");
  const msgId   = String(msg["internetMessageId"] ?? msg["id"] ?? "");
  const bodyObj = msg["body"] as Record<string,string> | undefined;
  const isHtml  = bodyObj?.["contentType"] === "html";
  const content = bodyObj?.["content"] ?? "";
  const mime    = isHtml ? "text/html" : "text/plain";

  return [
    `From: ${fromHeader}`,
    `To: ${toStr}`,
    ...(ccStr ? [`CC: ${ccStr}`] : []),
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: ${msgId}`,
    `MIME-Version: 1.0`,
    `Content-Type: ${mime}; charset=utf-8`,
    `X-Folder: ${folderName}`,
    ``,
    content,
  ].join("\r\n");
}

async function runEmlExport(
  token: string, folders: MailFolder[], since: string | undefined,
  params: ExportParams, onProgress: (msg: string) => void
): Promise<{ filePath: string; count: number }> {
  const selectFields = buildSelectFields(params);
  const exportDir = path.join(getOutputDir(), `eml_export_${timestamp()}`);
  fs.mkdirSync(exportDir, { recursive: true });
  let count = 0; let total = 0;

  onProgress(`Exporting EML files → ${exportDir}`);
  for (const folder of folders) {
    const safeFolder = folder.displayName.replace(/[/\\:*?"<>|]/g, "_");
    const folderDir  = path.join(exportDir, safeFolder);
    fs.mkdirSync(folderDir, { recursive: true });
    onProgress(`📁 ${folder.displayName}…`);

    for await (const msg of iterFolderMessages(token, folder.id, since, selectFields)) {
      total++;
      if (total % 25 === 0) onProgress(`Written ${count} .eml files…`);

      const fromEa = ((msg["from"] as Record<string,unknown>|undefined)?.["emailAddress"] as Record<string,string>|undefined) ?? {};
      const { email: fromEmail } = extractAddress(fromEa);
      if (params.filterExcludedDomain && fromEmail && isExcluded(fromEmail, params.excludedDomain)) continue;

      const sentRaw = String(msg["sentDateTime"] ?? "");
      const safeDate = sentRaw ? sentRaw.replace(/[:/\s]/g, "-").substring(0, 19) : `msg_${count}`;
      const safeId   = String(msg["id"] ?? count).replace(/[/\\:*?"<>|]/g, "").substring(0, 32);
      fs.writeFileSync(path.join(folderDir, `${safeDate}_${safeId}.eml`),
        buildEml(msg, folder.displayName), "utf-8");
      count++;
    }
  }

  onProgress(`Exported ${count} .eml files (${total} scanned).`);
  return { filePath: exportDir, count };
}

// ── Electron window ───────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960, height: 860,
    minWidth: 720, minHeight: 620,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#1e1e2e",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
    show: false,
  });
  mainWindow.loadFile(path.join(__dirname, "..", "src", "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow!.show());
  mainWindow.on("closed", () => { mainWindow = null; });
}

// ── IPC ───────────────────────────────────────────────────────────────────────
function send(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload);
}

ipcMain.handle("get-status", async () => {
  const token = await getAccessTokenSilent();
  return { authenticated: token !== null };
});

ipcMain.handle("connect", async () => {
  const onProgress = (msg: string) => send("progress", { message: msg });
  try {
    await authenticateInteractive(onProgress);
    return { authenticated: true };
  } catch (err) {
    send("error", { message: err instanceof Error ? err.message : String(err) });
    return { authenticated: false };
  }
});

ipcMain.handle("list-folders", async () => {
  const onProgress = (msg: string) => send("progress", { message: msg });
  try {
    let token = await getAccessTokenSilent();
    if (!token) token = await authenticateInteractive(onProgress);
    onProgress("Fetching mailbox folder list…");
    const folders = await listFoldersRecursive(token);
    return { folders };
  } catch (err) {
    send("error", { message: err instanceof Error ? err.message : String(err) });
    return { folders: [] };
  }
});

ipcMain.handle("start-extraction", async (
  _event,
  args: { folderIds: string[]; folderTree: MailFolder[]; since?: string; exportParams: ExportParams }
) => {
  const onProgress = (msg: string) => send("progress", { message: msg });
  try {
    let token = await getAccessTokenSilent();
    if (!token) token = await authenticateInteractive(onProgress);

    const allFolders: MailFolder[] = [];
    function flatten(nodes: MailFolder[]): void {
      for (const n of nodes) { allFolders.push(n); if (n.children) flatten(n.children); }
    }
    flatten(args.folderTree);
    const selected = allFolders.filter((f) => args.folderIds.includes(f.id));
    if (selected.length === 0) { send("error", { message: "No folders selected." }); return; }

    const { exportParams, since } = args;
    let result: { filePath: string; count: number };

    switch (exportParams.exportFormat) {
      case "emails-csv": result = await runEmailsCsvExport(token, selected, since, exportParams, onProgress); break;
      case "json":       result = await runJsonExport(token, selected, since, exportParams, onProgress); break;
      case "eml":        result = await runEmlExport(token, selected, since, exportParams, onProgress); break;
      default:           result = await runRecipientsExport(token, selected, since, exportParams, onProgress);
    }

    if (result.count === 0) {
      send("done", { outputPath: "", count: 0, format: exportParams.exportFormat });
    } else {
      send("done", { outputPath: result.filePath, count: result.count, format: exportParams.exportFormat });
    }
  } catch (err) {
    send("error", { message: err instanceof Error ? err.message : String(err) });
  }
});

ipcMain.handle("open-file", async (_event, args: { path: string }) => {
  await shell.openPath(args.path);
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
