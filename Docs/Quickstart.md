# Quickstart — Outlook Folder Extractor

A native Electron desktop app that connects to your **Microsoft 365 mailbox** via the
Microsoft Graph API (OAuth 2.0 PKCE — no password stored), lets you pick any folders
interactively, and exports emails in your preferred format.

---

## 1. Prerequisites

| Tool | Required for | Check |
|---|---|---|
| Node.js 18+ | Build only | `node --version` |
| npm 9+ | Build only | `npm --version` |
| Microsoft 365 account | Always | — |

No Azure App Registration needed — the default `CLIENT_ID` uses Microsoft's public
Graph Explorer client which works for any Microsoft 365 account.

---

## 2. Configure (optional)

Copy `.env.example` to `.env` at the project root. All defaults work out of the box —
editing is only needed if you want to use your own Azure App Registration or change
the default excluded domain.

**macOS / Linux:**
```bash
cp .env.example .env
```

**Windows (PowerShell):**
```powershell
Copy-Item .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `CLIENT_ID` | Graph Explorer public client | Azure App Registration client ID |
| `EXCLUDED_DOMAIN` | `.ibm.com` | Pre-fills the "Exclude addresses" field in the UI (can be changed at runtime) |
| `REDIRECT_URI` | `http://localhost:8765` | OAuth callback URI — must match Azure registration if using your own |
| `LOGIN_HINT` | _(empty)_ | Microsoft account email to pre-select at sign-in |

> **Need your own CLIENT_ID?**  
> Azure Portal → App registrations → New registration →  
> Redirect URI: `http://localhost:8765` (public client / native) →  
> API permissions → `Mail.Read` (delegated) → Grant admin consent →  
> Copy the **Application (client) ID** into `.env`.

---

## 3. Launch

The scripts handle `npm install` and TypeScript compilation automatically.

**macOS / Linux:**
```bash
bash scripts/start-electron-outlook.sh
```

**Windows (PowerShell):**
```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-electron-outlook.ps1
```

> **First run only (Windows):** if PowerShell blocks the script, run
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once in an elevated terminal.

**Or run directly from the app folder:**
```bash
cd electron-outlook && npm start
```

---

## 4. Using the app

### Step 1 — Connect
Click **"Connect to Microsoft"**. Your browser opens the Microsoft sign-in page.  
Sign in with your Outlook / Microsoft 365 account and accept `Mail.Read`.  
The status badge turns green: **Connected**.

### Step 2 — Load folders
Click **"Load Folders"**. The app fetches your full mailbox folder tree recursively
and renders it with item counts and expand/collapse controls.

```
📤 Sent Items          1 234 items
📥 Inbox               456 items
  ▶ 📁 Subfolder A      89 items
📝 Drafts               12 items
📦 Archive            2 100 items
```

- Click **▶** to expand sub-folders.
- Use **Select all** / **Deselect all** to toggle all at once.

### Step 3 — Choose export format

| Format | Output |
|---|---|
| **Recipients CSV** | Unique sender/recipient addresses + display names |
| **Emails CSV** | One row per message with your selected fields |
| **EML Files** | One `.eml` file per message, organised by folder |
| **JSON** | Structured array of message objects |
| **Attachments** | Attached files saved as binary files, sub-foldered by mailbox folder name; filterable by file type |

### Step 4 — Select fields *(CSV / JSON / EML)*
Toggle which fields to include per message:
**From · To/CC · Subject · Body (plain text) · Body (HTML) · Attachments metadata**

> EML exports always include From, To/CC, Subject, and Body — field toggles apply to extra metadata only.
> Field toggles are not shown for **Recipients CSV** and **Attachments** (not applicable).

### Step 4b — Attachment file types *(Attachments format only)*
When the **Attachments** format is selected, a file-type picker appears below the flagged filter:

| Chip | Saved extensions |
|---|---|
| **All types** *(default, green)* | every file |
| **📄 PDF** | `.pdf` |
| **📝 Word** | `.doc` `.docx` `.dot` `.dotx` `.odt` |
| **📊 PowerPoint** | `.ppt` `.pptx` `.pot` `.potx` `.pps` `.ppsx` `.odp` |
| **📈 Excel** | `.xls` `.xlsx` `.xlsm` `.xlt` `.xltx` `.ods` `.csv` |
| **🖼️ Images** | `.jpg` `.jpeg` `.png` `.gif` `.bmp` `.webp` `.tiff` `.svg` `.heic` |

- Select **All types** to save every attachment regardless of extension.
- Select one or more specific types to save only those (combinations are allowed — e.g. PDF + Images).
- Selecting a specific type automatically deselects **All types**, and deselecting all specific types reverts to **All types**.

### Step 5 — Domain filter
The **"Exclude addresses containing"** field pre-fills from `EXCLUDED_DOMAIN` in `.env`.
Edit it directly in the UI, or uncheck the box to disable filtering entirely.

### Step 6 — (Optional) Flagged emails only
Check **"🚩 Flagged emails only"** to restrict the extraction to messages that have been
flagged / marked for follow-up in Outlook. When enabled, unflagged messages are silently
skipped in every export format. This filter combines with all other filters (domain exclusion,
date range, field toggles, folder selection).

### Step 7 — (Optional) Date filter
Enter a **"Scan emails since"** date to limit the scan to messages on or after that date.

### Step 8 — Run
Click **"Run Extraction"**. The progress log shows live updates:

```
📁 Sent Items…
Fetched 50 messages…
Fetched 100 messages…
Done: 247 messages exported.
✅ Done — 247 messages saved to CSV.
```

Click **"Open Output"** to open the result file or folder.

---

## 5. Output

All exports go to `electron-outlook/output/` with a timestamp (gitignored):

```
output/
├── recipients_20250625_143022.csv          # Recipients CSV
├── emails_20250625_143022.csv              # Emails CSV
├── emails_20250625_143022.json             # JSON
├── eml_export_20250625_143022/             # EML files
│   ├── Sent Items/
│   │   └── 2025-06-25T14-30-22_<id>.eml
│   └── Inbox/
│       └── 2025-06-25T10-00-00_<id>.eml
└── attachments_20250625_143022/            # Attachments export
    ├── Sent Items/
    │   ├── report.xlsx
    │   └── photo.jpg
    └── Inbox/
        └── invoice.pdf
```

> Duplicate filenames within the same mailbox folder are automatically deduplicated:
> `report.xlsx`, `report_1.xlsx`, `report_2.xlsx`, …

### Recipients CSV columns

| Column | Description |
|---|---|
| `Name` | Recipient display name |
| `Email` | Recipient email address |
| `LastSent` | Date of the most recent email to/from them |

---

## 6. Stop the app

**macOS / Linux:**
```bash
bash scripts/stop-electron-outlook.sh
```

**Windows (PowerShell):**
```powershell
powershell -ExecutionPolicy Bypass -File scripts\stop-electron-outlook.ps1
```

---

## 7. Force re-login (clear token cache)

**macOS / Linux:**
```bash
rm ~/.cache/extract_outlook_token_folder.json
```

**Windows (PowerShell):**
```powershell
Remove-Item "$env:USERPROFILE\.cache\extract_outlook_token_folder.json" -ErrorAction SilentlyContinue
```

---

## Troubleshooting

| Problem | Solution |
|---|---|
| Window does not open | Run the launch script — it rebuilds automatically |
| Folders list is empty | Click **Connect to Microsoft** first (green badge required) |
| Browser doesn't open for sign-in | Copy the auth URL printed to the terminal and paste it into your browser |
| Port 8765 already in use | Change `REDIRECT_URI=http://localhost:XXXX` in `.env` and update your Azure App Registration |
| `HTTP 401` | Delete the token cache (§ 7 above) and reconnect |
| `HTTP 403` | Admin consent for `Mail.Read` may be required in your organisation's tenant |
| App blocked by macOS Gatekeeper | Right-click Electron.app → Open → confirm in the dialog |
| Script blocked by Windows SmartScreen | Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` in an elevated PowerShell |
| No output produced | Check the domain filter — it may be excluding all messages; try unchecking it |

---

*Made with IBM Bob*
