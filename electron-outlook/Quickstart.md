# Quickstart — Electron Folder Extractor

A native desktop app that connects to your **Microsoft 365 mailbox**, lets you pick
any folders interactively, and exports emails in your preferred format via the
Microsoft Graph API (OAuth 2.0 PKCE — no password stored).

For full details see [`Docs/Quickstart.md`](../Docs/Quickstart.md).

---

## Quick reference

### Launch

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
4. **Choose export format** — Recipients CSV · Emails CSV · EML Files · JSON · **SQLite**
5. **Select fields** *(CSV / JSON / SQLite / EML)* — From · To/CC · Subject · Body · Attachments
6. **Domain filter** — edit the excluded domain directly in the UI (default: `.ibm.com`)
7. **Date filter** *(optional)* — limit scan to emails since a given date
8. **Run Extraction** — live progress log; click **Open Output** when done

---

## Export formats

| Format | Output file | Contents | Re-run behaviour |
|---|---|---|---|
| Recipients CSV | `output/recipients_TIMESTAMP.csv` | Unique addresses + display names | New file each run |
| Emails CSV | `output/emails_TIMESTAMP.csv` | One row per message, selected fields | New file each run |
| EML Files | `output/eml_export_TIMESTAMP/<Folder>/` | One `.eml` per message | New directory each run |
| JSON | `output/emails_TIMESTAMP.json` | Structured array of message objects | New file each run |
| **SQLite** | `output/emails.sqlite` | Persistent database — all selected fields | **Upserts existing rows — no duplicates** |

> The SQLite database uses `message_id` as the primary key.  Re-running the export
> updates existing records and inserts only new ones.  An `exported_at` column records
> when each row was last written.

---

## Configuration (`.env` at project root)

| Variable | Default | Description |
|---|---|---|
| `CLIENT_ID` | Graph Explorer public client | Azure App Registration client ID |
| `EXCLUDED_DOMAIN` | `.ibm.com` | Default pre-fill for the domain filter in the UI |
| `REDIRECT_URI` | `http://localhost:8765` | OAuth callback URI |
| `LOGIN_HINT` | _(empty)_ | Microsoft account email to pre-select at sign-in |

---

*Made with IBM Bob*
