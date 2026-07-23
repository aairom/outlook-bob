# Quickstart — Electron Folder Extractor

A native desktop app that connects to your **Microsoft 365 mailbox**, lets you pick
any folders interactively, and exports emails in your preferred format via the
Microsoft Graph API (OAuth 2.0 PKCE — no password stored). A **Monday.com Boards**
panel is also available to browse your boards directly from the app.

> **All options reset to defaults on every launch** — format, fields, filters, date,
> and ZIP toggle are always cleared when the app opens.
>
> **Extraction history is persistent** — every successfully extracted message is recorded by its Graph `messageId` in `output/extraction_history.sqlite`. On subsequent runs, already-extracted messages are automatically skipped. Use **⚡ Force Extraction Override** to re-extract everything regardless of history, or click **🗑 Clear history** to wipe the record.

For full details see [`Docs/Quickstart.md`](../Docs/Quickstart.md).

---

## Quick reference

### Launch

All launch methods resolve Monday credentials from workspace-root `.bob/mcp.json` first,
then fall back to workspace-root `.env` via `MONDAY_API_TOKEN`.

```bash
# macOS / Linux
bash scripts/start-electron-outlook.sh

# Windows
powershell -ExecutionPolicy Bypass -File scripts\start-electron-outlook.ps1

# Or directly
cd electron-outlook && npm start
```

### Stop

```bash
# macOS / Linux
bash scripts/stop-electron-outlook.sh

# Windows
powershell -ExecutionPolicy Bypass -File scripts\stop-electron-outlook.ps1
```

### Clear token cache (force re-login)

```bash
# macOS / Linux
rm ~/.cache/extract_outlook_token_folder.json
```

---

## Workflow

1. **Connect** — click "Connect to Microsoft", sign in, accept `Mail.Read`
2. **Load Folders** — fetches your full mailbox tree with item counts
3. **Select folders** — check any combination; expand sub-folders with ▶
4. **Choose export format** — Recipients CSV · Emails CSV · EML Files · JSON · SQLite · Preview
5. **Select fields** *(CSV / JSON / SQLite / EML)* — From · To/CC · Subject · Body (text/HTML) · Attachments
6. **Domain filter** — edit the excluded domain directly in the UI (default: `.ibm.com`)
7. **Flagged only** *(optional)* — restrict to flagged/follow-up messages
8. **Save attachments** *(optional)* — save binary files to disk, filterable by type
9. **Date range** *(optional)* — set "since" and/or "to" dates to restrict the scan window (both are optional; "to" must be later than "since")
10. **Force Extraction Override** *(optional)* — check ⚡ to re-extract messages that have already been recorded in the history database
11. **ZIP output** *(optional)* — check "📦 Compress output as ZIP file" to compress the result; original file/directory is removed after ZIP is created
12. **Run Extraction** — live progress log shows skipped count; click **Open Output** when done
12. **View Monday Boards** *(optional, independent)* — scroll to the **Monday.com Boards** card and click **📋 View My Boards**; requires a valid Monday API token in workspace-root `.bob/mcp.json` or `MONDAY_API_TOKEN` in workspace-root `.env`
13. **EML → Monday Triage** *(optional)* — use the triage card to push `.eml` exports to Monday; pick a skill from the **🧠 Skill** dropdown or browse a prompt file (use ✏️ / 👁 to edit or preview it in-app)

---

## Export formats

| Format | Output file | Contents | Re-run behaviour |
|---|---|---|---|
| Recipients CSV | `output/recipients_TIMESTAMP.csv` | Unique addresses + display names | New file each run |
| Emails CSV | `output/emails_TIMESTAMP.csv` | One row per message, selected fields | New file each run |
| EML Files | `output/eml_export_TIMESTAMP/<Folder>/` | One `.eml` per message | New directory each run |
| JSON | `output/emails_TIMESTAMP.json` | Structured array of message objects | New file each run |
| **SQLite** | `output/emails.sqlite` | Persistent database — all selected fields | **Upserts — no duplicates** |

## Extraction history

Every extraction is tracked in a dedicated SQLite database at `output/extraction_history.sqlite`:

| Column | Description |
|---|---|
| `message_id` | Graph message GUID (primary key — unique per mailbox) |
| `export_id` | SHA-256(messageId + internetMessageId) — portable fingerprint |
| `extracted_at` | ISO-8601 timestamp of the extraction run |

**Deduplication logic:** before each run the app loads all known `message_id` values into memory. Any message already present in the history is skipped — it never reaches the export function. The log line `⏭ N already-extracted message(s)` shows how many were skipped in a given run.

**Force Extraction Override:** checking the ⚡ checkbox bypasses the history check entirely. Messages are re-extracted and history entries are updated to the current timestamp (`INSERT OR IGNORE` — new messages are added; existing ones are left untouched unless the history is cleared first).

**Clear history:** click 🗑 **Clear history** (shown in the run card when the history is non-empty) to delete all records from `extraction_history.sqlite`. The file itself is kept; it will be repopulated on the next run.

> **Body (plain text):** HTML tags are stripped automatically so both body toggles always
> produce content — Microsoft Graph always returns HTML for message bodies.

> **ZIP:** when "Compress output as ZIP file" is checked, the result is saved as
> `output/<name>_TIMESTAMP.zip` and the original file/directory is removed.

---

## Configuration (workspace-root `.env` and `.bob/mcp.json`)

| Variable | Default | Description |
|---|---|---|
| `CLIENT_ID` | Graph Explorer public client | Azure App Registration client ID |
| `EXCLUDED_DOMAIN` | `.ibm.com` | Default pre-fill for the domain filter in the UI |
| `REDIRECT_URI` | `http://localhost:8765` | OAuth callback URI |
| `LOGIN_HINT` | _(empty)_ | Microsoft account email to pre-select at sign-in |
| `MONDAY_BASE_URL` | `https://monday.com` | Base URL used to build Monday item links in the UI |
| `MONDAY_API_TOKEN` | _(empty)_ | Fallback Monday API token when workspace-root `.bob/mcp.json` does not provide `mcpServers.monday.headers.Authorization` |

Monday token priority:
1. workspace-root `.bob/mcp.json` → `mcpServers.monday.headers.Authorization`
2. workspace-root `.env` → `MONDAY_API_TOKEN`

---

*Made with IBM Bob*
