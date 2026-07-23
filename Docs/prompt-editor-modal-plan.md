# Plan: Prompt File Editor / Preview Modal

## Overview

Add **Edit (✏️)** and **Preview (👁)** icon-buttons next to the "📄 Prompt file" Browse button.
When a file is selected, clicking either button opens an **in-app overlay modal** (dark backdrop +
centered panel) that lets the user:

- **Edit mode** — read the file into a `<textarea>`, make changes, Save (writes back to disk) or Cancel.
- **Preview mode** — render the markdown as styled HTML via **`marked.js` loaded from CDN**; a tab bar lets the user toggle between Edit and Preview within the same modal.

No new Electron window is required. Two new IPC channels (`read-file`, `write-file`) are added to
`main.ts` and exposed through `preload.ts`.

**Confirmed design decisions:**
- Markdown renderer: `marked.js` from CDN (full markdown support).
- Modal height: **fixed height with internal scrolling** (textarea and preview pane scroll independently).

---

## Sub-Tasks

---

### Sub-Task 1 — IPC: `read-file` and `write-file` channels

**Intent**
The renderer cannot access the filesystem directly. Two new IPC channels are needed so the modal
can load and persist prompt file content.

**Expected Outcomes**
- `ipcMain.handle("read-file", ...)` reads and returns UTF-8 text for a given absolute path.
- `ipcMain.handle("write-file", ...)` writes UTF-8 text to a given absolute path.
- Both channels are exposed on `window.api` via `preload.ts`.

**Todo List**
1. In `electron-outlook/src/main.ts`, add a `read-file` handler after the existing `show-open-dialog` handler (~line 1452). It receives `{ path: string }` and returns `{ ok: boolean; content?: string; error?: string }`.
2. Add a `write-file` handler immediately after. It receives `{ path: string; content: string }` and returns `{ ok: boolean; error?: string }`.
3. In `electron-outlook/src/preload.ts`, expose `readFile(path)` and `writeFile(path, content)` bridge methods on the `api` object.

**Relevant Context**
- Existing handler pattern: `ipcMain.handle("show-open-dialog", ...)` at ~line 1440 of `main.ts`.
- Preload bridge pattern: `showOpenDialog` at ~line 182 of `preload.ts`.

**Status** — `[ ] pending`

---

### Sub-Task 2 — HTML + CSS: overlay modal markup and styles

**Intent**
Create a reusable in-app modal overlay (dark backdrop + centered card) that hosts the prompt
editor and preview. It must match the existing dark-theme design language (CSS variables,
`border-radius: 12px`, monospace textarea, etc.).

**Expected Outcomes**
- A hidden `#prompt-modal` overlay exists in the DOM (display: none by default).
- The overlay has: backdrop, centered card, title bar, Edit/Preview tab buttons, `<textarea id="prompt-editor">`, `<div id="prompt-preview">`, and Save / Cancel footer buttons.
- CSS classes: `.prompt-modal-overlay`, `.prompt-modal-card`, `.prompt-modal-tabs`, `.prompt-modal-body`, `.prompt-modal-footer`.
- The modal is fully scrollable if content is long.
- Markdown preview is rendered using **`marked.js`** loaded from CDN (`<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js">`).

**Todo List**
1. Add the `#prompt-modal` HTML block at the bottom of `<body>` in `index.html` (before the closing `</body>` tag).
2. Add the CSS rules for `.prompt-modal-overlay` (fixed, full-screen, z-index high, semi-transparent black), `.prompt-modal-card`, tabs, body, footer to the `<style>` block.
3. Modal card uses a **fixed height** (e.g. `80vh`) with the body pane (`textarea` / preview div) set to `overflow-y: auto; flex: 1` so content scrolls independently.
4. Ensure `-webkit-app-region: no-drag` is applied to all interactive elements inside the modal.

**Relevant Context**
- Existing card styles: `.card` at ~line 71 of `index.html`.
- Existing dark-theme CSS variables: `--surface`, `--border`, `--accent`, `--text-muted` used throughout.
- Body closing tag is near line 2600+ of `index.html`.

**Status** — `[ ] pending`

---

### Sub-Task 3 — HTML: Edit / Preview buttons on the Prompt file row

**Intent**
Add ✏️ and 👁 icon-buttons to the prompt file row that appear only when a file path is set.

**Expected Outcomes**
- Two `<button>` elements (`#btn-edit-prompt`, `#btn-preview-prompt`) are rendered in the `.eml-triage-row` for the prompt file, after `#btn-pick-prompt-file`.
- Both buttons start with `display: none` and become visible (`display: inline-flex`) when `_emlPromptPath` is set.
- Styling: small, icon-only, matching the existing button style but compact (similar to how small action buttons appear elsewhere).

**Todo List**
1. In `index.html`, locate the prompt file row (~line 1056-1061) and add `<button id="btn-edit-prompt">✏️</button>` and `<button id="btn-preview-prompt">👁</button>` after `#btn-pick-prompt-file`.
2. Add CSS for `#btn-edit-prompt, #btn-preview-prompt` — small square buttons, consistent with theme.
3. In the Browse click handler (~line 2490), after setting `_emlPromptPath`, show both new buttons.

**Relevant Context**
- Prompt file row: `index.html` ~line 1056.
- Browse handler: `index.html` ~line 2490.
- Existing button styles can be reused/extended.

**Status** — `[ ] pending`

---

### Sub-Task 4 — JS: modal open, tab switch, save, cancel wiring

**Intent**
Wire the four interactions: open-for-edit, open-for-preview, tab toggle, save-to-disk, close.

**Expected Outcomes**
- Clicking ✏️ calls `api.readFile(_emlPromptPath)`, populates the textarea, shows the modal in Edit tab.
- Clicking 👁 calls `api.readFile(_emlPromptPath)`, renders markdown into `#prompt-preview`, shows the modal in Preview tab.
- Tab buttons toggle between `#prompt-editor` (textarea) and `#prompt-preview` (rendered HTML).
- Save button calls `api.writeFile(_emlPromptPath, textarea.value)`, shows a brief inline success/error message, then closes the modal.
- Cancel / backdrop-click closes the modal without saving.
- While the modal is open, the backdrop should block interaction with the cards behind it.

**Todo List**
1. Add a `openPromptModal(mode)` helper function in the renderer JS section of `index.html`.
2. Wire `#btn-edit-prompt` click → `openPromptModal("edit")`.
3. Wire `#btn-preview-prompt` click → `openPromptModal("preview")`.
4. Wire tab button clicks to toggle visible pane and active tab style.
5. Wire Save button: call `api.writeFile`, handle success/error inline, close on success.
6. Wire Cancel button and overlay backdrop click to close modal.
7. Use `marked.parse(content)` (from the CDN `marked.js` script tag added in Sub-Task 2) to render markdown into `#prompt-preview`.

**Relevant Context**
- `api.readFile` / `api.writeFile` will be added in Sub-Task 1.
- `_emlPromptPath` variable: `index.html` ~line 2471.
- Renderer JS block starts around line 2430 of `index.html`.

**Status** — `[ ] pending`

---

## Implementation Order

Sub-Task 1 → Sub-Task 2 → Sub-Task 3 → Sub-Task 4

Each sub-task touches a distinct layer (backend IPC → HTML/CSS → HTML buttons → JS logic) and can
be reviewed independently before the next begins.
