import { app, BrowserWindow, ipcMain, shell } from "electron";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as crypto from "crypto";
import { URL, URLSearchParams } from "url";
import * as dotenv from "dotenv";
import Database from "better-sqlite3";
import { ZipArchive } from "archiver";

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
const EXCLUDED_DOMAIN  = process.env.EXCLUDED_DOMAIN  ?? ".ibm.com";
const LOGIN_HINT       = process.env.LOGIN_HINT       ?? "";
const MONDAY_BASE_URL  = process.env.MONDAY_BASE_URL  ?? "https://monday.com";
const BOX_CLIENT_ID    = process.env.BOX_CLIENT_ID    ?? "";
const BOX_CLIENT_SECRET= process.env.BOX_CLIENT_SECRET?? "";
const BOX_REDIRECT_URI = process.env.BOX_REDIRECT_URI ?? "http://localhost:8766";
const BOX_REDIRECT_PORT= parseInt(new URL(BOX_REDIRECT_URI).port || "8766", 10);
const BOX_API_BASE     = "https://api.box.com/2.0";
const BOX_UPLOAD_BASE  = "https://upload.box.com/api/2.0";
const BOX_AUTH_BASE    = "https://ibm.ent.box.com";
const ONEDRIVE_BASE    = "https://graph.microsoft.com/v1.0/me/drive";

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

interface MessageExportIdentity {
  exportId: string;
  messageId: string;
  internetMessageId: string;
  outlookWebLink: string;
}

export interface ExportParams {
  /** "recipients-csv" | "emails-csv" | "eml" | "json" | "sqlite" */
  exportFormat: "recipients-csv" | "emails-csv" | "eml" | "json" | "sqlite";
  includeFrom:            boolean;
  includeToCC:            boolean;
  includeSubject:         boolean;
  includeBodyText:        boolean;
  includeBodyHtml:        boolean;
  includeAttachmentsMeta: boolean;
  filterExcludedDomain:   boolean;
  /** Domain substring to exclude, e.g. ".ibm.com". Falls back to env EXCLUDED_DOMAIN. */
  excludedDomain:         string;
  /** When true, only messages with flag.flagStatus === "flagged" are exported. */
  flaggedOnly:            boolean;
  /** When true, attachment files are saved to disk alongside the primary export. */
  saveAttachments:        boolean;
  /**
   * File-type filter for attachment saving.
   * Empty array (or ["all"]) means save every file type.
   * Otherwise contains one or more of: "pdf","docx","pptx","xlsx","images"
   */
  attachmentTypes:        string[];
  /** When true, the primary export output (file or folder) is compressed into a .zip archive. */
  zipOutput:              boolean;
}

// ── Attachment-type filter helpers ────────────────────────────────────────────
/** Extensions grouped by the UI type label */
const ATTACHMENT_TYPE_EXTS: Record<string, string[]> = {
  pdf:    [".pdf"],
  docx:   [".doc", ".docx", ".dot", ".dotx", ".odt"],
  pptx:   [".ppt", ".pptx", ".pot", ".potx", ".pps", ".ppsx", ".odp"],
  xlsx:   [".xls", ".xlsx", ".xlsm", ".xlt", ".xltx", ".ods", ".csv"],
  images: [".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".svg", ".heic", ".heif"],
};

/**
 * Returns true when the file should be saved given the active type filter.
 * An empty / ["all"] filter allows every extension.
 */
function isAttachmentTypeAllowed(filename: string, types: string[]): boolean {
  if (!types || types.length === 0 || types.includes("all")) return true;
  const ext = path.extname(filename).toLowerCase();
  return types.some((t) => (ATTACHMENT_TYPE_EXTS[t] ?? []).includes(ext));
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
  const data = JSON.parse(await httpsGet(url, {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    Prefer: 'IdType="ImmutableId"',
  })) as Record<string, unknown>;
  if (data["error"]) {
    const err = data["error"] as Record<string, unknown>;
    throw new Error(`Graph API error: ${err["code"]} — ${err["message"]}`);
  }
  return data;
}

// ── Build $select field list from export params ───────────────────────────────
function buildSelectFields(params: ExportParams): string {
  const fields = new Set<string>(["id", "sentDateTime", "internetMessageId", "webLink"]);

  // Always fetch flag status when the flaggedOnly filter is active
  if (params.flaggedOnly) { fields.add("flag"); }

  // Always need hasAttachments when saving attachments alongside
  if (params.saveAttachments) { fields.add("hasAttachments"); fields.add("from"); }

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
  token: string, folderId: string, since: string | undefined, selectFields: string,
  orderBy = true
): AsyncGenerator<Record<string, unknown>> {
  let url: string | null =
    `${GRAPH_BASE}/me/mailFolders/${folderId}/messages` +
    `?$select=${encodeURIComponent(selectFields)}&$top=50` +
    (orderBy ? `&$orderby=sentDateTime%20desc` : "") +
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

// ── Download attachment binary content ────────────────────────────────────────
async function fetchAttachmentContent(
  token: string, messageId: string, attachmentId: string
): Promise<Buffer | null> {
  try {
    const url = `${GRAPH_BASE}/me/messages/${messageId}/attachments/${attachmentId}/$value`;
    const raw = await httpsGet(url, { Authorization: `Bearer ${token}`, Accept: "*/*" });
    return Buffer.from(raw, "binary");
  } catch { return null; }
}

// ── Fetch full attachments (id + name + content) ──────────────────────────────
async function fetchAttachmentsFull(
  token: string, messageId: string
): Promise<Array<{ id: string; name: string; contentType: string; content: Buffer | null }>> {
  try {
    const url = `${GRAPH_BASE}/me/messages/${messageId}/attachments?$select=id,name,contentType,@microsoft.graph.downloadUrl&$top=50`;
    const data = (await graphGet(token, url)) as { value: Array<Record<string, unknown>> };
    const results: Array<{ id: string; name: string; contentType: string; content: Buffer | null }> = [];
    for (const a of data.value ?? []) {
      // fileAttachment items carry contentBytes in base64 directly
      const contentBytes = a["contentBytes"] as string | undefined;
      let content: Buffer | null = null;
      if (contentBytes) {
        content = Buffer.from(contentBytes, "base64");
      } else {
        // Fetch via $value endpoint
        content = await fetchAttachmentContent(token, messageId, String(a["id"] ?? ""));
      }
      results.push({
        id:          String(a["id"] ?? ""),
        name:        String(a["name"] ?? "attachment"),
        contentType: String(a["contentType"] ?? "application/octet-stream"),
        content,
      });
    }
    return results;
  } catch { return []; }
}

// ── Save attachments for a single message (shared by all export runners) ──────
/**
 * Downloads and writes attachment files for `messageId` into `folderDir`.
 * Applies the `attachmentTypes` filter and deduplicates filenames.
 * Returns the number of files written.
 */
async function saveAttachmentsForMessage(
  token: string,
  messageId: string,
  folderDir: string,
  attachmentTypes: string[]
): Promise<number> {
  const attachments = await fetchAttachmentsFull(token, messageId);
  let written = 0;
  for (const att of attachments) {
    if (!att.content) continue;
    if (!isAttachmentTypeAllowed(att.name, attachmentTypes)) continue;
    fs.mkdirSync(folderDir, { recursive: true });
    const safeName = att.name.replace(/[/\\:*?"<>|]/g, "_");
    let destPath = path.join(folderDir, safeName);
    let suffix = 1;
    while (fs.existsSync(destPath)) {
      const ext  = path.extname(safeName);
      const base = path.basename(safeName, ext);
      destPath = path.join(folderDir, `${base}_${suffix}${ext}`);
      suffix++;
    }
    fs.writeFileSync(destPath, att.content);
    written++;
  }
  return written;
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

function buildMessageExportIdentity(msg: Record<string, unknown>): MessageExportIdentity {
  const messageId = String(msg["id"] ?? "");
  const internetMessageId = String(msg["internetMessageId"] ?? "");
  return {
    exportId: crypto.createHash("sha256").update(`${messageId}\n${internetMessageId}`).digest("hex"),
    messageId,
    internetMessageId,
    outlookWebLink: String(msg["webLink"] ?? ""),
  };
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

// ── ZIP helper ────────────────────────────────────────────────────────────────
/**
 * Compresses `sourcePath` (file or directory) into a timestamped .zip archive
 * placed next to it in the output directory.  Returns the zip file path.
 * The original file/directory is removed after successful compression.
 */
function wrapWithZip(sourcePath: string, onProgress: (msg: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const isDir  = fs.statSync(sourcePath).isDirectory();
    const base   = path.basename(sourcePath, path.extname(sourcePath));
    const zipPath = path.join(path.dirname(sourcePath), `${base}_${timestamp()}.zip`);

    onProgress(`📦 Compressing output → ${path.basename(zipPath)}…`);

    const output  = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });

    output.on("close", () => {
      // Remove the original file / directory after successful zip
      if (isDir) fs.rmSync(sourcePath, { recursive: true, force: true });
      else       fs.unlinkSync(sourcePath);
      onProgress(`📦 ZIP ready: ${zipPath} (${(archive.pointer() / 1024).toFixed(1)} KB)`);
      resolve(zipPath);
    });
    archive.on("error", reject);
    archive.pipe(output);

    if (isDir) archive.directory(sourcePath, false);
    else       archive.file(sourcePath, { name: path.basename(sourcePath) });

    archive.finalize();
  });
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
      if (params.flaggedOnly) {
        const flagStatus = ((msg["flag"] as Record<string,string>|undefined)?.["flagStatus"]) ?? "";
        if (flagStatus !== "flagged") continue;
      }
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

  if (params.saveAttachments) {
    onProgress("Downloading attachments for matched messages…");
    const attDir = path.join(getOutputDir(), `attachments_${timestamp()}`);
    let attCount = 0;
    for (const folder of folders) {
      const safeFolder = folder.displayName.replace(/[/\\:*?"<>|]/g, "_");
      const folderDir  = path.join(attDir, safeFolder);
      for await (const msg of iterFolderMessages(token, folder.id, since, buildSelectFields(params))) {
        if (!msg["hasAttachments"]) continue;
        attCount += await saveAttachmentsForMessage(token, msg["id"] as string, folderDir, params.attachmentTypes);
      }
    }
    onProgress(`Attachments saved: ${attCount} file(s) → ${attDir}`);
  }

  return { filePath, count: recipients.size };
}

// ── FORMAT: emails-csv (one row per message) ──────────────────────────────────
async function runEmailsCsvExport(
  token: string, folders: MailFolder[], since: string | undefined,
  params: ExportParams, onProgress: (msg: string) => void
): Promise<{ filePath: string; count: number }> {
  const selectFields = buildSelectFields(params);
  const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
  const headers = ["exportId","messageId","internetMessageId","outlookWebLink","sentDateTime","from","fromName","toRecipients",
                   "ccRecipients","subject","bodyText","bodyHtml","attachments","folder"];
  const rows: string[] = [];
  let total = 0;

  onProgress(`Scanning ${folders.length} folder(s) — full email CSV…`);
  for (const folder of folders) {
    onProgress(`📁 ${folder.displayName}…`);
    for await (const msg of iterFolderMessages(token, folder.id, since, selectFields)) {
      total++;
      if (total % 50 === 0) onProgress(`Fetched ${total} messages…`);

      if (params.flaggedOnly) {
        const flagStatus = ((msg["flag"] as Record<string,string>|undefined)?.["flagStatus"]) ?? "";
        if (flagStatus !== "flagged") continue;
      }

      const fromEa = ((msg["from"] as Record<string,unknown>|undefined)?.["emailAddress"] as Record<string,string>|undefined) ?? {};
      const { name: fromName, email: fromEmail } = extractAddress(fromEa);
      if (params.filterExcludedDomain && fromEmail && isExcluded(fromEmail, params.excludedDomain)) continue;

      const bodyObj     = msg["body"] as Record<string,string> | undefined;
      const isHtml      = bodyObj?.["contentType"] === "html";
      const bodyContent = bodyObj?.["content"] ?? "";
      // Plain-text view: strip HTML tags when the server returned HTML
      const bodyPlain   = isHtml ? bodyContent.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim() : bodyContent;

      let attachmentsStr = "";
      if (params.includeAttachmentsMeta && msg["hasAttachments"]) {
        const atts = await fetchAttachmentsMeta(token, msg["id"] as string);
        attachmentsStr = JSON.stringify(atts);
      }

      const identity = buildMessageExportIdentity(msg);
      rows.push([
        esc(identity.exportId),
        esc(identity.messageId),
        esc(identity.internetMessageId),
        esc(identity.outlookWebLink),
        esc(String(msg["sentDateTime"] ?? "")),
        esc(params.includeFrom    ? fromEmail  : ""),
        esc(params.includeFrom    ? fromName   : ""),
        esc(params.includeToCC    ? recipientListStr((msg["toRecipients"] as Array<Record<string,unknown>>|undefined) ?? []) : ""),
        esc(params.includeToCC    ? recipientListStr((msg["ccRecipients"] as Array<Record<string,unknown>>|undefined) ?? []) : ""),
        esc(params.includeSubject ? String(msg["subject"] ?? "") : ""),
        esc(params.includeBodyText ? bodyPlain   : ""),
        esc(params.includeBodyHtml ? bodyContent : ""),
        esc(params.includeAttachmentsMeta ? attachmentsStr : ""),
        esc(folder.displayName),
      ].join(","));
    }
  }

  onProgress(`Done: ${rows.length} messages exported.`);
  if (rows.length === 0) return { filePath: "", count: 0 };

  const filePath = path.join(getOutputDir(), `emails_${timestamp()}.csv`);
  fs.writeFileSync(filePath, headers.join(",") + "\n" + rows.join("\n"), "utf-8");
  await maybeSaveAttachments(token, folders, since, params, onProgress);
  return { filePath, count: rows.length };
}

// shared: save attachments after any export run
async function maybeSaveAttachments(
  token: string, folders: MailFolder[], since: string | undefined,
  params: ExportParams, onProgress: (msg: string) => void
): Promise<void> {
  if (!params.saveAttachments) return;
  onProgress("Downloading attachments for matched messages…");
  const attDir = path.join(getOutputDir(), `attachments_${timestamp()}`);
  let attCount = 0;
  for (const folder of folders) {
    const safeFolder = folder.displayName.replace(/[/\\:*?"<>|]/g, "_");
    const folderDir  = path.join(attDir, safeFolder);
    const attSelect  = ["id", "hasAttachments", "from", "sentDateTime",
                        ...(params.flaggedOnly ? ["flag"] : [])].join(",");
    for await (const msg of iterFolderMessages(token, folder.id, since, attSelect)) {
      if (params.flaggedOnly) {
        const flagStatus = ((msg["flag"] as Record<string,string>|undefined)?.["flagStatus"]) ?? "";
        if (flagStatus !== "flagged") continue;
      }
      const fromEa = ((msg["from"] as Record<string,unknown>|undefined)?.["emailAddress"] as Record<string,string>|undefined) ?? {};
      const { email: fromEmail } = extractAddress(fromEa);
      if (params.filterExcludedDomain && fromEmail && isExcluded(fromEmail, params.excludedDomain)) continue;
      if (!msg["hasAttachments"]) continue;
      attCount += await saveAttachmentsForMessage(token, msg["id"] as string, folderDir, params.attachmentTypes);
    }
  }
  onProgress(`Attachments saved: ${attCount} file(s) → ${attDir}`);
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

      if (params.flaggedOnly) {
        const flagStatus = ((msg["flag"] as Record<string,string>|undefined)?.["flagStatus"]) ?? "";
        if (flagStatus !== "flagged") continue;
      }

      const fromEa = ((msg["from"] as Record<string,unknown>|undefined)?.["emailAddress"] as Record<string,string>|undefined) ?? {};
      const { name: fromName, email: fromEmail } = extractAddress(fromEa);
      if (params.filterExcludedDomain && fromEmail && isExcluded(fromEmail, params.excludedDomain)) continue;

      const bodyObj     = msg["body"] as Record<string,string> | undefined;
      const isHtml      = bodyObj?.["contentType"] === "html";
      const bodyContent = bodyObj?.["content"] ?? "";
      const bodyPlain   = isHtml ? bodyContent.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim() : bodyContent;

      const identity = buildMessageExportIdentity(msg);
      const rec: Record<string, unknown> = {
        exportId:          identity.exportId,
        messageId:         identity.messageId,
        internetMessageId: identity.internetMessageId,
        outlookWebLink:    identity.outlookWebLink,
        sentDateTime:      msg["sentDateTime"],
        folder:            folder.displayName,
      };
      if (params.includeFrom)    { rec["from"] = fromEmail; rec["fromName"] = fromName; }
      if (params.includeToCC) {
        rec["toRecipients"] = recipientListStr((msg["toRecipients"] as Array<Record<string,unknown>>|undefined) ?? []);
        rec["ccRecipients"] = recipientListStr((msg["ccRecipients"] as Array<Record<string,unknown>>|undefined) ?? []);
      }
      if (params.includeSubject)  rec["subject"]  = msg["subject"];
      if (params.includeBodyText) rec["bodyText"]  = bodyPlain;
      if (params.includeBodyHtml) rec["bodyHtml"]  = bodyContent;
      if (params.includeAttachmentsMeta && msg["hasAttachments"])
        rec["attachments"] = await fetchAttachmentsMeta(token, msg["id"] as string);

      records.push(rec);
    }
  }

  onProgress(`Done: ${records.length} messages exported.`);
  if (records.length === 0) return { filePath: "", count: 0 };

  const filePath = path.join(getOutputDir(), `emails_${timestamp()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(records, null, 2), "utf-8");
  await maybeSaveAttachments(token, folders, since, params, onProgress);
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

  const identity = buildMessageExportIdentity(msg);

  return [
    `From: ${fromHeader}`,
    `To: ${toStr}`,
    ...(ccStr ? [`CC: ${ccStr}`] : []),
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: ${msgId}`,
    `X-Export-ID: ${identity.exportId}`,
    ...(identity.messageId ? [`X-Graph-Message-ID: ${identity.messageId}`] : []),
    ...(identity.internetMessageId ? [`X-Internet-Message-ID: ${identity.internetMessageId}`] : []),
    ...(identity.outlookWebLink ? [`X-Outlook-Web-Link: ${identity.outlookWebLink}`] : []),
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

      if (params.flaggedOnly) {
        const flagStatus = ((msg["flag"] as Record<string,string>|undefined)?.["flagStatus"]) ?? "";
        if (flagStatus !== "flagged") continue;
      }

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
  await maybeSaveAttachments(token, folders, since, params, onProgress);
  return { filePath: exportDir, count };
}

// ── FORMAT: SQLite (idempotent – keyed on messageId) ─────────────────────────
/**
 * Opens (or creates) a persistent SQLite database in the output directory.
 * The database file is NOT timestamped so that re-running the export upserts
 * records instead of creating duplicates.  A `exported_at` column records
 * when each row was last written.
 *
 * Schema (emails table):
 *   message_id TEXT PRIMARY KEY
 *   export_id TEXT
 *   internet_message_id TEXT
 *   outlook_web_link TEXT
 *   sent_datetime TEXT
 *   folder TEXT
 *   from_email TEXT
 *   from_name TEXT
 *   to_recipients TEXT
 *   cc_recipients TEXT
 *   subject TEXT
 *   body_text TEXT
 *   body_html TEXT
 *   attachments TEXT   (JSON)
 *   exported_at TEXT   (ISO timestamp of last upsert)
 */
async function runSqliteExport(
  token: string, folders: MailFolder[], since: string | undefined,
  params: ExportParams, onProgress: (msg: string) => void
): Promise<{ filePath: string; count: number }> {
  const dbPath   = path.join(getOutputDir(), "emails.sqlite");
  const db       = new Database(dbPath);

  // Enable WAL for better concurrent access
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS emails (
      message_id           TEXT PRIMARY KEY,
      export_id            TEXT,
      internet_message_id  TEXT,
      outlook_web_link     TEXT,
      sent_datetime        TEXT,
      folder               TEXT,
      from_email           TEXT,
      from_name            TEXT,
      to_recipients        TEXT,
      cc_recipients        TEXT,
      subject              TEXT,
      body_text            TEXT,
      body_html            TEXT,
      attachments          TEXT,
      exported_at          TEXT
    );
  `);
  const existingColumns = db.prepare("PRAGMA table_info(emails)").all() as Array<{ name: string }>;
  const existingColumnNames = new Set(existingColumns.map((column) => column.name));
  if (!existingColumnNames.has("export_id")) db.exec("ALTER TABLE emails ADD COLUMN export_id TEXT");
  if (!existingColumnNames.has("internet_message_id")) db.exec("ALTER TABLE emails ADD COLUMN internet_message_id TEXT");
  if (!existingColumnNames.has("outlook_web_link")) db.exec("ALTER TABLE emails ADD COLUMN outlook_web_link TEXT");

  const upsert = db.prepare(`
    INSERT INTO emails
      (message_id, export_id, internet_message_id, outlook_web_link, sent_datetime, folder, from_email, from_name,
       to_recipients, cc_recipients, subject, body_text, body_html,
       attachments, exported_at)
    VALUES
      (@message_id, @export_id, @internet_message_id, @outlook_web_link, @sent_datetime, @folder, @from_email, @from_name,
       @to_recipients, @cc_recipients, @subject, @body_text, @body_html,
       @attachments, @exported_at)
    ON CONFLICT(message_id) DO UPDATE SET
      export_id            = excluded.export_id,
      internet_message_id  = excluded.internet_message_id,
      outlook_web_link     = excluded.outlook_web_link,
      sent_datetime        = excluded.sent_datetime,
      folder               = excluded.folder,
      from_email           = excluded.from_email,
      from_name            = excluded.from_name,
      to_recipients        = excluded.to_recipients,
      cc_recipients        = excluded.cc_recipients,
      subject              = excluded.subject,
      body_text            = excluded.body_text,
      body_html            = excluded.body_html,
      attachments          = excluded.attachments,
      exported_at          = excluded.exported_at
  `);

  const selectFields = buildSelectFields(params);
  let total = 0; let upserted = 0;
  const exportedAt = new Date().toISOString();

  // Wrap all inserts in a single transaction for performance
  const insertAll = db.transaction((rows: object[]) => {
    for (const row of rows) upsert.run(row);
  });

  onProgress(`Scanning ${folders.length} folder(s) — SQLite export → ${dbPath}`);

  for (const folder of folders) {
    onProgress(`📁 ${folder.displayName}…`);
    const batch: object[] = [];

    for await (const msg of iterFolderMessages(token, folder.id, since, selectFields)) {
      total++;
      if (total % 50 === 0) onProgress(`Fetched ${total} messages…`);

      if (params.flaggedOnly) {
        const flagStatus = ((msg["flag"] as Record<string,string>|undefined)?.["flagStatus"]) ?? "";
        if (flagStatus !== "flagged") continue;
      }

      const fromEa = ((msg["from"] as Record<string,unknown>|undefined)?.["emailAddress"] as Record<string,string>|undefined) ?? {};
      const { name: fromName, email: fromEmail } = extractAddress(fromEa);
      if (params.filterExcludedDomain && fromEmail && isExcluded(fromEmail, params.excludedDomain)) continue;

      const bodyObj     = msg["body"] as Record<string,string> | undefined;
      const isHtml      = bodyObj?.["contentType"] === "html";
      const bodyContent = bodyObj?.["content"] ?? "";
      const bodyPlain   = isHtml ? bodyContent.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim() : bodyContent;

      let attachmentsStr = "";
      if (params.includeAttachmentsMeta && msg["hasAttachments"])
        attachmentsStr = JSON.stringify(await fetchAttachmentsMeta(token, msg["id"] as string));

      const identity = buildMessageExportIdentity(msg);
      batch.push({
        message_id:           identity.messageId,
        export_id:            identity.exportId,
        internet_message_id:  identity.internetMessageId,
        outlook_web_link:     identity.outlookWebLink,
        sent_datetime:        String(msg["sentDateTime"] ?? ""),
        folder:               folder.displayName,
        from_email:           params.includeFrom    ? fromEmail  : "",
        from_name:            params.includeFrom    ? fromName   : "",
        to_recipients:        params.includeToCC    ? recipientListStr((msg["toRecipients"] as Array<Record<string,unknown>>|undefined) ?? []) : "",
        cc_recipients:        params.includeToCC    ? recipientListStr((msg["ccRecipients"] as Array<Record<string,unknown>>|undefined) ?? []) : "",
        subject:              params.includeSubject ? String(msg["subject"] ?? "") : "",
        body_text:            params.includeBodyText ? bodyPlain   : "",
        body_html:            params.includeBodyHtml ? bodyContent : "",
        attachments:          attachmentsStr,
        exported_at:          exportedAt,
      });
      upserted++;
    }

    // Commit this folder's batch
    insertAll(batch);
  }

  db.close();

  onProgress(`Done: ${upserted} records upserted into ${dbPath} (${total} scanned).`);
  if (upserted === 0) return { filePath: "", count: 0 };

  await maybeSaveAttachments(token, folders, since, params, onProgress);
  return { filePath: dbPath, count: upserted };
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
  return { authenticated: token !== null, mondayBaseUrl: MONDAY_BASE_URL };
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
      case "sqlite":     result = await runSqliteExport(token, selected, since, exportParams, onProgress); break;
      default:           result = await runRecipientsExport(token, selected, since, exportParams, onProgress);
    }

    if (result.count === 0) {
      send("done", { outputPath: "", count: 0, format: exportParams.exportFormat });
    } else {
      // Optionally compress the output file/folder into a ZIP archive
      let finalPath = result.filePath;
      if (exportParams.zipOutput && finalPath) {
        finalPath = await wrapWithZip(finalPath, onProgress);
      }
      send("done", { outputPath: finalPath, count: result.count, format: exportParams.exportFormat });
    }
  } catch (err) {
    send("error", { message: err instanceof Error ? err.message : String(err) });
  }
});

// ── Preview emails (return messages as objects for on-screen display) ─────────
ipcMain.handle("preview-emails", async (
  _event,
  args: { folderIds: string[]; folderTree: MailFolder[]; since?: string; limit?: number; flaggedOnly?: boolean }
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
    if (selected.length === 0) return { messages: [], error: "No folders selected." };

    const limit = args.limit ?? 100;
    const selectFields = "id,sentDateTime,from,toRecipients,ccRecipients,subject,body,hasAttachments,flag,isRead,importance";
    const messages: Array<Record<string, unknown>> = [];

    for (const folder of selected) {
      onProgress(`📁 Loading ${folder.displayName}…`);
      for await (const msg of iterFolderMessages(token, folder.id, args.since, selectFields, false)) {
        if (args.flaggedOnly) {
          const flagStatus = ((msg["flag"] as Record<string,string>|undefined)?.["flagStatus"]) ?? "";
          if (flagStatus !== "flagged") continue;
        }
        const fromEa = ((msg["from"] as Record<string,unknown>|undefined)?.["emailAddress"] as Record<string,string>|undefined) ?? {};
        const bodyObj = msg["body"] as Record<string,string>|undefined;
        const isHtml  = bodyObj?.["contentType"] === "html";
        const bodyRaw = bodyObj?.["content"] ?? "";
        const bodyText = isHtml
          ? bodyRaw.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim()
          : bodyRaw;
        messages.push({
          id:             msg["id"],
          sentDateTime:   msg["sentDateTime"],
          from:           fromEa["address"] ?? "",
          fromName:       fromEa["name"] ?? "",
          to:             recipientListStr((msg["toRecipients"] as Array<Record<string,unknown>>|undefined) ?? []),
          subject:        String(msg["subject"] ?? "(no subject)"),
          bodyText,
          bodyHtml:       isHtml ? bodyRaw : "",
          isRead:         msg["isRead"] ?? true,
          isFlagged:      ((msg["flag"] as Record<string,string>|undefined)?.["flagStatus"]) === "flagged",
          importance:     String(msg["importance"] ?? "normal"),
          hasAttachments: msg["hasAttachments"] ?? false,
          folder:         folder.displayName,
        });
        if (messages.length >= limit) break;
      }
      if (messages.length >= limit) break;
    }
    onProgress(`✅ Loaded ${messages.length} message(s).`);
    return { messages };
  } catch (err) {
    return { messages: [], error: err instanceof Error ? err.message : String(err) };
  }
});


/**
 * Writes EML files for messages that were already fetched in preview mode.
 * Preview messages carry pre-processed fields (from, fromName, to, subject,
 * bodyText, bodyHtml, sentDateTime, folder, …) rather than raw Graph objects,
 * so we build the EML directly from those fields.
 */
ipcMain.handle(
  "download-selected-emails",
  async (_event, args: { messages: Array<Record<string, unknown>> }) => {
    try {
      if (!args.messages?.length) return { count: 0, outputPath: "", error: "No emails provided." };

      const exportDir = path.join(getOutputDir(), `preview_download_${timestamp()}`);
      fs.mkdirSync(exportDir, { recursive: true });
      let count = 0;

      for (const msg of args.messages) {
        const fromEmail  = String(msg["from"]     ?? "");
        const fromName   = String(msg["fromName"] ?? "");
        const fromHeader = fromName && fromName !== fromEmail
          ? `"${fromName}" <${fromEmail}>` : (fromEmail || "unknown@unknown");
        const toStr    = String(msg["to"]           ?? "");
        const subject  = String(msg["subject"]      ?? "(no subject)");
        const date     = String(msg["sentDateTime"] ?? "");
        const folder   = String(msg["folder"]       ?? "");
        const msgId    = String(msg["id"]           ?? count);

        const bodyHtml = String(msg["bodyHtml"] ?? "");
        const bodyText = String(msg["bodyText"] ?? "");
        const hasHtml  = bodyHtml.length > 0;
        const content  = hasHtml ? bodyHtml : bodyText;
        const mime     = hasHtml ? "text/html" : "text/plain";

        const eml = [
          `From: ${fromHeader}`,
          `To: ${toStr}`,
          `Subject: ${subject}`,
          `Date: ${date}`,
          `Message-ID: ${msgId}`,
          `MIME-Version: 1.0`,
          `Content-Type: ${mime}; charset=utf-8`,
          ...(folder ? [`X-Folder: ${folder}`] : []),
          ``,
          content,
        ].join("\r\n");

        const safeDate = date ? date.replace(/[:/\s]/g, "-").substring(0, 19) : `msg_${count}`;
        const safeId   = msgId.replace(/[/\\:*?"<>|]/g, "").substring(0, 32);
        fs.writeFileSync(path.join(exportDir, `${safeDate}_${safeId}.eml`), eml, "utf-8");
        count++;
      }

      return { count, outputPath: exportDir };
    } catch (err) {
      return { count: 0, outputPath: "", error: err instanceof Error ? err.message : String(err) };
    }
  }
);

ipcMain.handle("open-file", async (_event, args: { path: string }) => {
  if (args.path.startsWith("http://") || args.path.startsWith("https://")) {
    await shell.openExternal(args.path);
  } else {
    await shell.openPath(args.path);
  }
});

// ── Monday Boards ─────────────────────────────────────────────────────────────
// Token resolution order (first non-empty value wins):
//   1. .bob/mcp.json  mcpServers.monday.headers.Authorization  (Bob MCP server — preferred)
//   2. MONDAY_API_TOKEN environment variable from .env          (standalone / CI fallback)
const MONDAY_API_TOKEN = (() => {
  const candidates = [
    path.join(__dirname, "..", "..", "..", ".bob", "mcp.json"),
    path.join(__dirname, "..", "..", ".bob", "mcp.json"),
    path.join(process.resourcesPath ?? "", ".bob", "mcp.json"),
  ];
  for (const c of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(c, "utf8"));
      const token = cfg?.mcpServers?.monday?.headers?.Authorization;
      if (token) return token as string;
    } catch { /* not found */ }
  }
  // Fallback: MONDAY_API_TOKEN from .env (loaded at startup via dotenv)
  const envToken = process.env.MONDAY_API_TOKEN;
  if (envToken) return envToken;
  return null;
})();

function mondayGraphQL(query: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!MONDAY_API_TOKEN) {
      reject(new Error("Monday API token not configured. Set it in .bob/mcp.json (mcpServers.monday.headers.Authorization) or as MONDAY_API_TOKEN in .env"));
      return;
    }
    const body = JSON.stringify({ query });
    const options = {
      hostname: "api.monday.com",
      path: "/v2",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": MONDAY_API_TOKEN,
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Failed to parse Monday API response")); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

ipcMain.handle("list-monday-boards", async () => {
  try {
    const query = `{ boards(limit: 100, order_by: used_at) {
      id name description board_kind state
      items_count
      workspace { id name }
      columns { id title type }
    } }`;
    const result = await mondayGraphQL(query) as { data?: { boards?: unknown[] }; errors?: unknown[] };
    if (result.errors) {
      const msg = JSON.stringify(result.errors);
      send("monday-error", { message: msg });
      return { boards: [] };
    }
    return { boards: result.data?.boards ?? [] };
  } catch (err) {
    send("monday-error", { message: err instanceof Error ? err.message : String(err) });
    return { boards: [] };
  }
});

ipcMain.handle("get-monday-board-items", async (_event, args: { boardId: string }) => {
  try {
    // Fetch up to 200 items with their column values; filter out Done on the renderer side
    const query = `{
      boards(ids: [${args.boardId}]) {
        columns { id title type }
        items_page(limit: 200) {
          items {
            id
            name
            state
            relative_link
            column_values {
              id
              type
              text
              ... on StatusValue { label index }
              ... on DateValue   { date }
            }
          }
        }
      }
    }`;
    const result = await mondayGraphQL(query) as {
      data?: { boards?: Array<{
        columns: Array<{ id: string; title: string; type: string }>;
        items_page: { items: unknown[] };
      }> };
      errors?: unknown[];
    };
    if (result.errors) {
      return { items: [], columns: [], error: JSON.stringify(result.errors) };
    }
    const board = result.data?.boards?.[0];
    return {
      columns: board?.columns ?? [],
      items: board?.items_page?.items ?? [],
    };
  } catch (err) {
    return { items: [], columns: [], error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("create-monday-item", async (_event, args: { boardId: string; itemName: string }) => {
  try {
    const escaped = args.itemName.replace(/"/g, '\\"');
    const mutation = `mutation {
      create_item(board_id: ${args.boardId}, item_name: "${escaped}") { id name }
    }`;
    const result = await mondayGraphQL(mutation) as {
      data?: { create_item?: { id: string; name: string } };
      errors?: unknown[];
    };
    if (result.errors) {
      return { item: null, error: JSON.stringify(result.errors) };
    }
    return { item: result.data?.create_item ?? null };
  } catch (err) {
    return { item: null, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("add-monday-item-update", async (_event, args: { itemId: string; body: string }) => {
  try {
    const escaped = args.body.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
    const mutation = `mutation {
      create_update(item_id: ${args.itemId}, body: "${escaped}") { id }
    }`;
    const result = await mondayGraphQL(mutation) as {
      data?: { create_update?: { id: string } };
      errors?: unknown[];
    };
    if (result.errors) {
      return { update: null, error: JSON.stringify(result.errors) };
    }
    return { update: result.data?.create_update ?? null };
  } catch (err) {
    return { update: null, error: err instanceof Error ? err.message : String(err) };
  }
});

// ── Box integration ───────────────────────────────────────────────────────────

// Box token cache — separate file from Microsoft token
function getBoxTokenCacheFile(): string {
  return path.join(app.getPath("home"), ".cache", "extract_box_token.json");
}

function loadBoxTokenCache(): TokenCache | null {
  try {
    if (fs.existsSync(getBoxTokenCacheFile()))
      return JSON.parse(fs.readFileSync(getBoxTokenCacheFile(), "utf-8")) as TokenCache;
  } catch { /* corrupt */ }
  return null;
}

function saveBoxTokenCache(cache: TokenCache): void {
  fs.mkdirSync(path.dirname(getBoxTokenCacheFile()), { recursive: true });
  fs.writeFileSync(getBoxTokenCacheFile(), JSON.stringify(cache, null, 2), "utf-8");
}

function clearBoxTokenCache(): void {
  try { if (fs.existsSync(getBoxTokenCacheFile())) fs.unlinkSync(getBoxTokenCacheFile()); } catch { /* ignore */ }
}

async function getBoxAccessToken(): Promise<string | null> {
  const cache = loadBoxTokenCache();
  if (!cache) return null;
  if (Date.now() < cache.expires_at) return cache.access_token;
  // Refresh using refresh_token
  if (cache.refresh_token) {
    try {
      const raw = await httpsPost(
        `${BOX_AUTH_BASE}/api/oauth2/token`,
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: cache.refresh_token,
          client_id: BOX_CLIENT_ID,
          client_secret: BOX_CLIENT_SECRET,
        }).toString(),
        { "Content-Type": "application/x-www-form-urlencoded" }
      );
      const json = JSON.parse(raw);
      if (!json.access_token) { clearBoxTokenCache(); return null; }
      const newCache: TokenCache = {
        access_token:  json.access_token,
        refresh_token: json.refresh_token ?? cache.refresh_token,
        expires_at:    Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000,
        scope:         json.scope ?? "",
      };
      saveBoxTokenCache(newCache);
      return newCache.access_token;
    } catch { clearBoxTokenCache(); return null; }
  }
  return null;
}

async function authenticateBoxInteractive(onProgress: (msg: string) => void): Promise<string> {
  if (!BOX_CLIENT_ID) throw new Error("BOX_CLIENT_ID is not set in .env — add your Box app credentials.");
  if (!BOX_CLIENT_SECRET) throw new Error("BOX_CLIENT_SECRET is not set in .env — add your Box app credentials.");

  const state   = b64url(crypto.randomBytes(16));
  const authUrl = new URL(`${BOX_AUTH_BASE}/api/oauth2/authorize`);
  authUrl.searchParams.set("client_id",     BOX_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri",  BOX_REDIRECT_URI);
  authUrl.searchParams.set("state",         state);

  onProgress("Opening browser for Box authentication (IBM w3id)…");

  const { code, receivedState } = await new Promise<{ code: string; receivedState: string }>(
    (resolve, reject) => {
      let done = false;
      const server = http.createServer((req, res) => {
        if (!req.url) { res.writeHead(400); res.end(); return; }
        const cb     = new URL(req.url, BOX_REDIRECT_URI);
        const code   = cb.searchParams.get("code");
        const error  = cb.searchParams.get("error");
        const rState = cb.searchParams.get("state") ?? "";
        const html = code
          ? "<html><body><h2 style='font-family:sans-serif;color:#107c10;margin:48px auto;max-width:480px'>✅ Box authentication successful. You can close this tab.</h2></body></html>"
          : "<html><body><h2 style='font-family:sans-serif;color:#d13438;margin:48px auto;max-width:480px'>❌ Box authentication error. Return to the app.</h2></body></html>";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        server.close();
        if (!done) {
          done = true;
          code ? resolve({ code, receivedState: rState })
               : reject(new Error(cb.searchParams.get("error_description") ?? error ?? "Unknown Box OAuth error"));
        }
      });
      server.listen(BOX_REDIRECT_PORT, "localhost", () => shell.openExternal(authUrl.toString()));
      server.on("error", (e) => { if (!done) { done = true; reject(e); } });
      setTimeout(() => {
        if (!done) { done = true; server.close(); reject(new Error("Box authentication timed out (2 minutes).")); }
      }, 120_000);
    }
  );

  if (receivedState !== state) throw new Error("Box OAuth state mismatch — possible CSRF.");
  onProgress("Exchanging Box authorization code for tokens…");

  const raw = await httpsPost(
    `${BOX_AUTH_BASE}/api/oauth2/token`,
    new URLSearchParams({
      grant_type:    "authorization_code",
      code,
      client_id:     BOX_CLIENT_ID,
      client_secret: BOX_CLIENT_SECRET,
      redirect_uri:  BOX_REDIRECT_URI,
    }).toString(),
    { "Content-Type": "application/x-www-form-urlencoded" }
  );
  const json = JSON.parse(raw);
  if (!json.access_token) throw new Error(`Box token exchange failed: ${JSON.stringify(json)}`);

  const cache: TokenCache = {
    access_token:  json.access_token,
    refresh_token: json.refresh_token,
    expires_at:    Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000,
    scope:         json.scope ?? "",
  };
  saveBoxTokenCache(cache);
  onProgress("☁️  Box authenticated successfully.");
  return cache.access_token;
}

/** Low-level authenticated GET against api.box.com */
function boxGet(token: string, urlPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const u = new URL(`${BOX_API_BASE}${urlPath}`);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode === 401) {
            reject(new Error("Box token expired — click 'Connect to Box' to re-authenticate."));
            return;
          }
          if (res.statusCode && res.statusCode >= 400) { reject(new Error(`Box HTTP ${res.statusCode}: ${data}`)); return; }
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/** List immediate folder children of a Box folder (default: root = "0") */
async function boxListFolders(token: string, parentId = "0"): Promise<Array<{ id: string; name: string }>> {
  const data = (await boxGet(token, `/folders/${parentId}/items?fields=id,name,type&limit=1000`)) as {
    entries: Array<{ id: string; name: string; type: string }>;
  };
  return (data.entries ?? []).filter((e) => e.type === "folder").map((e) => ({ id: e.id, name: e.name }));
}

/** Create a new Box folder under parentId, returns the new folder's id */
async function boxCreateFolder(token: string, name: string, parentId: string): Promise<string> {
  const body = JSON.stringify({ name, parent: { id: parentId } });
  const raw = await httpsPost(
    `${BOX_API_BASE}/folders`,
    body,
    { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" }
  );
  const json = JSON.parse(raw);
  if (!json.id) throw new Error(`Box folder creation failed: ${raw}`);
  return String(json.id);
}

/** Upload a local file to a Box folder via multipart/form-data */
function boxUploadFile(
  token: string,
  localPath: string,
  boxFolderId: string,
  onProgress: (msg: string) => void
): Promise<{ id: string; name: string }> {
  return new Promise((resolve, reject) => {
    const fileName = path.basename(localPath);
    let fileBuffer: Buffer;
    try { fileBuffer = fs.readFileSync(localPath); }
    catch { reject(new Error(`Cannot read local file: ${localPath}`)); return; }

    const boundary  = `----BoxUploadBoundary${crypto.randomBytes(8).toString("hex")}`;
    const attributes = JSON.stringify({ name: fileName, parent: { id: boxFolderId } });
    const part1 = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="attributes"\r\nContent-Type: application/json\r\n\r\n${attributes}\r\n`
    );
    const part2Header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const part2Footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const bodyBuffer  = Buffer.concat([part1, part2Header, fileBuffer, part2Footer]);

    const u = new URL(`${BOX_UPLOAD_BASE}/files/content`);
    onProgress(`☁️  Uploading ${fileName} to Box…`);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "POST",
        headers: {
          Authorization:   `Bearer ${token}`,
          "Content-Type":  `multipart/form-data; boundary=${boundary}`,
          "Content-Length": bodyBuffer.byteLength,
        }
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode === 401) {
            reject(new Error("Box token expired — click 'Connect to Box' to re-authenticate."));
            return;
          }
          if (res.statusCode && res.statusCode >= 400) { reject(new Error(`Box upload failed HTTP ${res.statusCode}: ${data}`)); return; }
          try {
            const json  = JSON.parse(data);
            const entry = json?.entries?.[0] ?? json;
            resolve({ id: String(entry.id ?? ""), name: String(entry.name ?? fileName) });
          } catch { reject(new Error(`Box upload response parse error: ${data}`)); }
        });
      }
    );
    req.on("error", reject);
    req.write(bodyBuffer);
    req.end();
  });
}

// ── Box IPC handlers ──────────────────────────────────────────────────────────

ipcMain.handle("connect-box", async () => {
  const onProgress = (msg: string) => send("progress", { message: msg });
  try {
    await authenticateBoxInteractive(onProgress);
    return { connected: true };
  } catch (err) {
    return { connected: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("box-logout", async () => {
  clearBoxTokenCache();
});

ipcMain.handle("get-box-status", async () => {
  const token = await getBoxAccessToken();
  return { connected: token !== null };
});

ipcMain.handle("list-box-folders", async () => {
  try {
    let token = await getBoxAccessToken();
    if (!token) return { folders: [], error: "Not connected to Box — click 'Connect to Box' first." };
    const folders = await boxListFolders(token);
    return { folders };
  } catch (err) {
    return { folders: [], error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("upload-to-box", async (
  _event,
  args: { localPath: string; boxFolderId: string; newFolderName?: string }
) => {
  const onProgress = (msg: string) => send("progress", { message: msg });
  try {
    let token = await getBoxAccessToken();
    if (!token) return { boxFileId: "", boxFileName: "", error: "Not connected to Box — click 'Connect to Box' first." };
    let targetFolderId = args.boxFolderId;
    if (args.newFolderName?.trim()) {
      onProgress(`📁 Creating Box folder "${args.newFolderName}"…`);
      targetFolderId = await boxCreateFolder(token, args.newFolderName.trim(), args.boxFolderId);
      onProgress(`📁 Box folder created.`);
    }
    const result = await boxUploadFile(token, args.localPath, targetFolderId, onProgress);
    onProgress(`☁️  Upload complete: ${result.name}`);
    return { boxFileId: result.id, boxFileName: result.name };
  } catch (err) {
    return { boxFileId: "", boxFileName: "", error: err instanceof Error ? err.message : String(err) };
  }
});

// ── Box Drive (local mount) ───────────────────────────────────────────────────

const BOX_DRIVE_CANDIDATES = [
  path.join(process.env.HOME ?? "", "Library", "CloudStorage", "Box-Box"),
  path.join(process.env.HOME ?? "", "Box"),
  "/Volumes/Box",
];

function detectBoxDrivePath(): string | null {
  for (const p of BOX_DRIVE_CANDIDATES) {
    try { if (fs.statSync(p).isDirectory()) return p; } catch { /* not found */ }
  }
  return null;
}

ipcMain.handle("get-boxdrive-status", async () => {
  const mountPath = detectBoxDrivePath();
  return { mounted: mountPath !== null, mountPath: mountPath ?? "" };
});

ipcMain.handle("list-boxdrive-folders", async () => {
  try {
    const mountPath = detectBoxDrivePath();
    if (!mountPath) return { folders: [], mountPath: "", error: "Box Drive folder not found. Is Box Drive installed and signed in?" };
    const entries = fs.readdirSync(mountPath, { withFileTypes: true });
    const folders = entries
      .filter(e => e.isDirectory() && !e.name.startsWith("."))
      .map(e => ({ name: e.name, path: path.join(mountPath, e.name) }));
    return { folders, mountPath };
  } catch (err) {
    return { folders: [], mountPath: "", error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("copy-to-boxdrive", async (
  _event,
  args: { localPath: string; destFolderPath: string; newFolderName?: string }
) => {
  const onProgress = (msg: string) => send("progress", { message: msg });
  try {
    let targetDir = args.destFolderPath || detectBoxDrivePath() || "";
    if (!targetDir) return { destPath: "", fileName: "", error: "Box Drive folder not found." };
    if (args.newFolderName?.trim()) {
      targetDir = path.join(targetDir, args.newFolderName.trim());
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      onProgress(`📁 Created Box Drive folder: ${args.newFolderName.trim()}`);
    }
    const fileName = path.basename(args.localPath);
    const dest = path.join(targetDir, fileName);
    onProgress(`📦 Copying ${fileName} to Box Drive…`);
    fs.copyFileSync(args.localPath, dest);
    onProgress(`📦 Copied to Box Drive — Box will sync automatically.`);
    return { destPath: dest, fileName };
  } catch (err) {
    return { destPath: "", fileName: "", error: err instanceof Error ? err.message : String(err) };
  }
});

// ── OneDrive integration ──────────────────────────────────────────────────────
// OneDrive reuses the existing Microsoft access token (getAccessTokenSilent).
// No new OAuth flow — the user is already authenticated via "Connect to Microsoft".

/** List OneDrive folders inside a given item path (default: root) */
async function oneDriveListFolders(
  token: string, parentPath = "root"
): Promise<Array<{ id: string; name: string; path: string }>> {
  const url = parentPath === "root"
    ? `${ONEDRIVE_BASE}/root/children?$filter=folder ne null&$select=id,name,folder,parentReference&$top=200`
    : `${ONEDRIVE_BASE}/items/${parentPath}/children?$filter=folder ne null&$select=id,name,folder,parentReference&$top=200`;
  const raw = JSON.parse(await httpsGet(url, {
    Authorization: `Bearer ${token}`, Accept: "application/json",
  })) as { value: Array<Record<string, unknown>>; error?: Record<string, unknown> };
  if (raw.error) throw new Error(`OneDrive list error: ${JSON.stringify(raw.error)}`);
  return (raw.value ?? []).map((item) => ({
    id:   String(item["id"]   ?? ""),
    name: String(item["name"] ?? ""),
    path: String((item["parentReference"] as Record<string,string> | undefined)?.["path"] ?? "") + "/" + String(item["name"] ?? ""),
  }));
}

/** Create a OneDrive folder under a parent item id, returns new item id */
async function oneDriveCreateFolder(
  token: string, name: string, parentId: string
): Promise<string> {
  const url  = `${ONEDRIVE_BASE}/items/${parentId}/children`;
  const body = JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "rename" });
  const raw  = await httpsPost(url, body, {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json",
  });
  const json = JSON.parse(raw);
  if (!json.id) throw new Error(`OneDrive folder creation failed: ${raw}`);
  return String(json.id);
}

/** Upload a file to OneDrive using the simple upload API (files up to 4 MB) or resumable session */
async function oneDriveUploadFile(
  token: string,
  localPath: string,
  parentId: string,
  onProgress: (msg: string) => void
): Promise<{ id: string; name: string; webUrl: string }> {
  const fileName   = path.basename(localPath);
  const fileBuffer = fs.readFileSync(localPath);
  const fileSize   = fileBuffer.byteLength;
  onProgress(`🔵  Uploading ${fileName} to OneDrive…`);

  if (fileSize <= 4 * 1024 * 1024) {
    // Simple upload for files ≤ 4 MB
    const url = `${ONEDRIVE_BASE}/items/${parentId}:/${encodeURIComponent(fileName)}:/content`;
    const raw = await new Promise<string>((resolve, reject) => {
      const u = new URL(url);
      const req = https.request(
        { hostname: u.hostname, path: u.pathname + u.search, method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream",
                     "Content-Length": fileSize } },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            if (res.statusCode === 401) { reject(new Error("OneDrive token expired — click 'Connect to Microsoft' to re-authenticate.")); return; }
            if (res.statusCode && res.statusCode >= 400) { reject(new Error(`OneDrive upload failed HTTP ${res.statusCode}: ${data}`)); return; }
            resolve(data);
          });
        }
      );
      req.on("error", reject);
      req.write(fileBuffer);
      req.end();
    });
    const json = JSON.parse(raw);
    return { id: String(json.id ?? ""), name: String(json.name ?? fileName), webUrl: String(json.webUrl ?? "") };
  }

  // Resumable upload session for files > 4 MB
  const sessionUrl = `${ONEDRIVE_BASE}/items/${parentId}:/${encodeURIComponent(fileName)}:/createUploadSession`;
  const sessionRaw = await httpsPost(sessionUrl,
    JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "rename", name: fileName } }),
    { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" }
  );
  const uploadUrl = JSON.parse(sessionRaw).uploadUrl as string;
  if (!uploadUrl) throw new Error("OneDrive: failed to create upload session.");

  const chunkSize = 3.2 * 1024 * 1024; // 3.2 MB chunks (must be multiple of 320 KiB)
  let offset = 0;
  let lastJson: Record<string, unknown> = {};
  while (offset < fileSize) {
    const end   = Math.min(offset + chunkSize, fileSize);
    const chunk = fileBuffer.slice(offset, end);
    onProgress(`🔵  OneDrive upload: ${Math.round((end / fileSize) * 100)}%…`);
    const chunkRaw = await new Promise<string>((resolve, reject) => {
      const u = new URL(uploadUrl);
      const req = https.request(
        { hostname: u.hostname, path: u.pathname + u.search, method: "PUT",
          headers: { "Content-Length": chunk.byteLength,
                     "Content-Range": `bytes ${offset}-${end - 1}/${fileSize}` } },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 400) { reject(new Error(`OneDrive chunk upload HTTP ${res.statusCode}: ${data}`)); return; }
            resolve(data);
          });
        }
      );
      req.on("error", reject);
      req.write(chunk);
      req.end();
    });
    if (chunkRaw) { try { lastJson = JSON.parse(chunkRaw); } catch { /* partial response */ } }
    offset = end;
  }
  return { id: String(lastJson["id"] ?? ""), name: String(lastJson["name"] ?? fileName), webUrl: String(lastJson["webUrl"] ?? "") };
}

// ── OneDrive IPC handlers ─────────────────────────────────────────────────────

ipcMain.handle("get-onedrive-status", async () => {
  const token = await getAccessTokenSilent();
  return { connected: token !== null };
});

ipcMain.handle("list-onedrive-folders", async () => {
  try {
    const token = await getAccessTokenSilent();
    if (!token) return { folders: [], error: "Not connected to Microsoft — click 'Connect to Microsoft' first." };
    const folders = await oneDriveListFolders(token, "root");
    return { folders };
  } catch (err) {
    return { folders: [], error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("upload-to-onedrive", async (
  _event,
  args: { localPath: string; oneDriveFolderId: string; newFolderName?: string }
) => {
  const onProgress = (msg: string) => send("progress", { message: msg });
  try {
    const token = await getAccessTokenSilent();
    if (!token) return { odFileId: "", odFileName: "", odWebUrl: "", error: "Not connected to Microsoft — click 'Connect to Microsoft' first." };
    let targetId = args.oneDriveFolderId;
    if (args.newFolderName?.trim()) {
      onProgress(`📁 Creating OneDrive folder "${args.newFolderName}"…`);
      targetId = await oneDriveCreateFolder(token, args.newFolderName.trim(), args.oneDriveFolderId);
      onProgress(`📁 OneDrive folder created.`);
    }
    const result = await oneDriveUploadFile(token, args.localPath, targetId, onProgress);
    onProgress(`🔵  OneDrive upload complete: ${result.name}`);
    return { odFileId: result.id, odFileName: result.name, odWebUrl: result.webUrl };
  } catch (err) {
    return { odFileId: "", odFileName: "", odWebUrl: "", error: err instanceof Error ? err.message : String(err) };
  }
});

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
