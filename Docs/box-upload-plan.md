# Plan — Box Upload Integration

## Top-Level Overview

Add the ability to upload extraction output files to Box, alongside or instead of saving locally.

**Scope:**
- Box authentication via a Developer Token stored in `.env` (no OAuth browser flow)
- A destination toggle in the UI: **Local / Box / Both**
- A Box folder picker: dropdown of existing Box folders + text field to create a new one
- After export completes, upload the output file(s) to the chosen Box folder
- All five existing export formats (CSV, JSON, EML, SQLite, ZIP) are supported
- No change to existing local export logic — Box upload is additive

**Non-goals:**
- Box OAuth 2.0 browser login (not needed with Developer Token)
- Syncing or two-way Box integration
- Browsing nested Box folder trees (root-level folders only for simplicity)

---

## Sub-Tasks

---

### Sub-task 1 — Box API helper module in `main.ts`

**Intent:**
Add a self-contained set of Box API functions in `main.ts` (no new files, following existing patterns). These functions will be used by the upload IPC handler and the folder listing handler.

**Expected Outcomes:**
- `BOX_TOKEN` is read from `process.env.BOX_TOKEN` with a clear fallback to `""`
- `boxGet(path)` — authenticated GET against `https://api.box.com/2.0`
- `boxListRootFolders()` — returns `{ id, name }[]` of immediate children of Box root folder (id=`"0"`) that are of type `folder`
- `boxCreateFolder(name, parentId)` — creates a folder under `parentId`, returns the new folder's id
- `boxUploadFile(localPath, boxFolderId)` — reads a local file and POSTs it to `https://upload.box.com/api/2.0/files/content`, returns the uploaded file id and name
- All functions throw descriptive errors when `BOX_TOKEN` is empty or the API returns non-2xx

**Todo List:**
1. Add `BOX_TOKEN = process.env.BOX_TOKEN ?? ""` constant near the other config constants
2. Implement `boxGet(urlPath: string): Promise<unknown>` using `httpsGet` with Bearer auth header to `api.box.com`
3. Implement `boxListRootFolders(): Promise<Array<{id:string; name:string}>>` — calls `GET /2.0/folders/0/items?fields=id,name,type&limit=1000` and filters `type === "folder"`
4. Implement `boxCreateFolder(name: string, parentId: string): Promise<string>` — POSTs to `/2.0/folders` with `{name, parent:{id:parentId}}`, returns new folder id
5. Implement `boxUploadFile(localPath: string, boxFolderId: string, onProgress: (msg:string) => void): Promise<void>` — reads the file, builds multipart form-data manually (no external library), POSTs to `https://upload.box.com/api/2.0/files/content`

**Relevant Context:**
- Existing `httpsGet` / `httpsPost` helpers in `main.ts` show the pattern for raw HTTPS calls
- Box upload endpoint requires `multipart/form-data` with two parts: `attributes` (JSON) and `file` (binary)
- Box API reference: `https://developer.box.com/reference/`
- `BOX_TOKEN` alongside `CLIENT_ID`, `EXCLUDED_DOMAIN` etc. at the top of `main.ts`

**Status:** [x] done

---

### Sub-task 2 — IPC handlers: list Box folders + upload to Box

**Intent:**
Expose two new IPC handlers to the renderer so the UI can fetch Box folder list and trigger a Box upload of a completed local export.

**Expected Outcomes:**
- `list-box-folders` handler returns `{ folders: Array<{id:string; name:string}>; error?: string }`
- `upload-to-box` handler accepts `{ localPath: string; boxFolderId: string; newFolderName?: string }` and:
  1. If `newFolderName` is provided, creates a new Box folder under `boxFolderId` and uses the new id
  2. Uploads the file at `localPath` to Box
  3. Sends `progress` events during upload
  4. Returns `{ boxFileId: string; boxFileName: string; error?: string }`
- Both handlers are added to `main.ts` following the existing `ipcMain.handle` pattern

**Todo List:**
1. Add `ipcMain.handle("list-box-folders", ...)` that calls `boxListRootFolders()`, wraps errors into `{ folders: [], error }`
2. Add `ipcMain.handle("upload-to-box", ...)` that:
   - Gets `localPath`, `boxFolderId`, optional `newFolderName` from args
   - If `newFolderName` is set, calls `boxCreateFolder(newFolderName, boxFolderId)` to get target folder id
   - Calls `boxUploadFile(localPath, targetFolderId, onProgress)`
   - Returns result or error object

**Relevant Context:**
- Existing handlers in `main.ts` at the bottom of the file (lines 1022–1239) are the pattern to follow
- `send("progress", { message })` is used for live progress updates to the renderer
- The `localPath` passed in will be the `outputPath` already returned by the `done` event

**Status:** [x] done

---

### Sub-task 3 — Expose Box IPC to renderer via `preload.ts`

**Intent:**
Add the two new IPC channels to the `contextBridge` so the renderer JavaScript can call them via `window.electronAPI`.

**Expected Outcomes:**
- `api.listBoxFolders()` is available in the renderer, returns `Promise<{ folders, error? }>`
- `api.uploadToBox({ localPath, boxFolderId, newFolderName? })` is available, returns `Promise<{ boxFileId, boxFileName, error? }>`

**Todo List:**
1. Add `PreviewMessage` interface is already present — add `BoxFolder` interface: `{ id: string; name: string }`
2. Add `listBoxFolders` to the `contextBridge.exposeInMainWorld` block
3. Add `uploadToBox` to the `contextBridge.exposeInMainWorld` block

**Relevant Context:**
- [`electron-outlook/src/preload.ts`](../electron-outlook/src/preload.ts) — add after `createMondayItem`
- Pattern: follow existing `listMondayBoards` / `getMondayBoardItems` shape

**Status:** [x] done

---

### Sub-task 4 — UI: destination toggle + Box folder picker in `index.html`

**Intent:**
Add a destination card to the renderer UI. It appears between the export options card and the date/run card. It lets the user choose where output goes and configure the Box folder.

**Expected Outcomes:**
- A new card "Output Destination" with a 3-way toggle: **💻 Local** / **☁️ Box** / **💻+☁️ Both** (pill buttons, only one active at a time)
- When **Box** or **Both** is selected:
  - A "Box folder" section appears with:
    - A **"Load Box folders"** button that calls `api.listBoxFolders()` and populates a `<select>` dropdown
    - A `<select>` dropdown listing fetched Box folders (each option has `value = folder.id`)
    - A text `<input>` labelled "Or create new folder named:" — when filled, a new Box folder will be created with that name under the selected folder; when empty, the selected existing folder is used
  - A Box status message area (loading / error / success)
- When **Local** is selected: Box section is hidden (CSS `display:none`)
- The destination choice is read in `getExportParams()` and included in the extraction call
- Box upload is triggered **after** `api.onDone` fires (i.e. local file is ready), using the `outputPath` from the `done` event

**Todo List:**
1. Add the destination card HTML between the export format card and the date+run card
2. Add CSS for the 3-way destination toggle (pill style, matching existing `.format-btn` pattern)
3. Add CSS for the Box folder section
4. Add JS: destination toggle logic — sets `selectedDestination` to `"local"`, `"box"`, or `"both"`; shows/hides Box folder section
5. Add JS: `btnLoadBoxFolders` click handler — calls `api.listBoxFolders()`, populates `<select>` or shows error
6. Modify `api.onDone` handler — after local done event, if destination includes `"box"`, call `api.uploadToBox(...)` with `outputPath`, selected folder id, and new folder name (if any); show progress in log; show Box success/error message
7. Add Box result display: append a log line `☁️ Uploaded to Box: <filename>` on success, or an error line on failure

**Relevant Context:**
- [`electron-outlook/src/renderer/index.html`](../electron-outlook/src/renderer/index.html)
- Existing `.format-btn` / `.format-btn.active` CSS pattern is reused for the destination toggle
- The `onDone` handler is at the bottom of the `<script>` block — Box upload is chained after it
- `outputPath` from the `done` event is the local file/zip path ready to upload

**Status:** [x] done

---

### Sub-task 5 — `.env.example` update + documentation

**Intent:**
Document the new `BOX_TOKEN` variable and update README and Quickstart so users know how to get a Developer Token from Box and configure it.

**Expected Outcomes:**
- `.env.example` has a new `BOX_TOKEN=` entry with a comment explaining where to get it
- `README.md` has a new "Box Integration" section explaining the token setup and how the destination toggle works
- `Docs/Quickstart.md` has a step covering Box setup (how to get a token, where to paste it)
- `Docs/Architecture.md` Mermaid diagram updated to include the Box upload path

**Todo List:**
1. Add `BOX_TOKEN=your_box_developer_token_here` to `.env.example` with a comment linking to `https://developer.box.com/` and explaining token lifetime (Developer Tokens expire after 60 min — note this)
2. Add "Box Integration" section to `README.md`
3. Add Box setup step to `Docs/Quickstart.md` section 3 (Configure)
4. Update `Docs/Architecture.md` Mermaid diagram to show the Box upload branch

**Status:** [x] done

---

## Implementation Notes

- Box Developer Tokens expire after **60 minutes**. The app should show a clear error message like "Box token expired — generate a new one at developer.box.com" when it gets a 401 from Box.
- Box upload uses a different base URL (`upload.box.com`) than the API (`api.box.com`) — handled in `boxUploadFile`.
- Multipart form-data for Box upload must be built manually (no `form-data` npm package) to avoid adding a new dependency. The boundary is a fixed string.
- The EML format produces a directory — the entire directory must be zipped before uploading to Box (auto-zip before upload if destination includes Box and format is EML).
- SQLite output is a single `.sqlite` file — uploadable as-is.
