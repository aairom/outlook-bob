# Plan: Email → Monday Board Item

## Overview

Add a **"📋 Send to Monday"** workflow in the Email Preview panel.
When one or more emails are checked in the preview list, a board-picker
dropdown and a Send button appear in the selection action bar, letting the
user push each selected email directly to a Monday board as a new item
(item name = email Subject; email body posted as an item Update/note).

No new screens, no new cards — the change is surgical: a dropdown + button
inside the existing `#preview-selection-bar` and a small IPC handler for
posting item updates.

---

## Sub-Tasks

### Sub-task 1 — IPC handler: `add-monday-item-update`

**Intent**
The current `create-monday-item` handler creates an item by name only.
Monday's `create_update` GraphQL mutation attaches a text note to an item.
We need a new IPC handler that calls that mutation so the renderer can post
the email body as an item update after the item is created.

**Expected Outcomes**
- `ipcMain.handle("add-monday-item-update", ...)` exists in `main.ts`
- It accepts `{ itemId: string; body: string }` and returns
  `{ update: { id: string } | null; error?: string }`
- It uses the existing `mondayGraphQL()` helper
- `preload.ts` exposes `addMondayItemUpdate(itemId, body)` via `contextBridge`

**Todo List**
1. In [`electron-outlook/src/main.ts`](electron-outlook/src/main.ts:1369), add
   `ipcMain.handle("add-monday-item-update", ...)` immediately after the
   existing `create-monday-item` handler (line 1369).
2. The mutation body:
   ```graphql
   mutation { create_update(item_id: <itemId>, body: "<escaped body>") { id } }
   ```
3. In [`electron-outlook/src/preload.ts`](electron-outlook/src/preload.ts:115),
   add `addMondayItemUpdate(itemId, body)` to the `contextBridge` block.

**Relevant Context**
- Existing pattern to follow: [`create-monday-item`](electron-outlook/src/main.ts:1352)
- `mondayGraphQL()` helper: [`main.ts:1257`](electron-outlook/src/main.ts:1257)
- Preload pattern: [`preload.ts:111`](electron-outlook/src/preload.ts:111)

**Status** `[x] done`

---

### Sub-task 2 — UI: board-picker dropdown in the selection bar

**Intent**
When the user checks emails, the selection bar (`#preview-selection-bar`)
should show a compact `<select>` populated with the user's Monday boards,
so they can pick the target board without scrolling to the Monday panel.
The dropdown is only populated after the user has explicitly clicked
**"📋 View My Boards"** in the Monday panel. Until then it shows a
placeholder `"— load boards first —"` and the Send button is disabled.
No auto-fetch is performed.

**Expected Outcomes**
- A `<select id="monday-board-picker">` element exists inside
  `#preview-selection-bar` in [`index.html`](electron-outlook/src/renderer/index.html:772)
- The select is populated (one `<option>` per board) **only** when the user
  has already fetched boards via the "📋 View My Boards" button — reusing
  the `boards` array already returned by that flow
- Until boards are loaded, the select shows `"— load boards first —"` and
  the Send button is disabled
- CSS for the dropdown follows the existing dark-theme select style already
  present in the file (reuse `background:#1e1e2e; border:1px solid #45475a;
  color:#cdd6f4` pattern)

**Todo List**
1. In the `#preview-selection-bar` div (line 772–776 of `index.html`), add:
   - `<select id="monday-board-picker">` with a default disabled option
   - `<button id="btn-send-to-monday">📋 Send to Monday</button>`
   - `<div id="send-monday-status">` for inline feedback (ok/err styled)
2. Add CSS for `#monday-board-picker` and `#btn-send-to-monday` and
   `#send-monday-status` in the `<style>` block.
3. In the JS boot section, declare `const mondayBoardPicker` and
   `const btnSendToMonday` and `const sendMondayStatus` element references.
4. After boards are successfully fetched in `btnMondayBoards.addEventListener`
   (line 2047), also populate `mondayBoardPicker` with the same boards array.
   Do NOT add any auto-fetch call — population happens only via this existing
   explicit user action.

**Relevant Context**
- Selection bar HTML: [`index.html:772-776`](electron-outlook/src/renderer/index.html:772)
- Boards fetch and render: [`index.html:2047`](electron-outlook/src/renderer/index.html:2047)
- Existing dark select style used elsewhere in the file for reference

**Status** `[x] done`

---

### Sub-task 3 — Renderer logic: send selected emails to Monday

**Intent**
Wire the **"📋 Send to Monday"** button so that when clicked it iterates
over checked emails and for each one:
1. Calls `api.createMondayItem(boardId, email.subject)` to create the item
2. Calls `api.addMondayItemUpdate(itemId, email.bodyText)` to attach the
   email body as a note
3. Reports progress inline in `#send-monday-status`

**Expected Outcomes**
- Clicking "📋 Send to Monday" with N emails checked and a board selected
  creates N Monday items, each with the email body as an update note
- The button shows a spinner/disabled state while working
- On completion, `#send-monday-status` shows
  `✅ N item(s) created on "<BoardName>"` (green) or
  `❌ <error message>` (red)
- If no board is selected in the picker, the button does nothing and shows
  `"Select a board first"` in the status div

**Todo List**
1. Add `btnSendToMonday.addEventListener("click", async () => { ... })` after
   the existing `btnDownloadSel` listener (~line 1657).
2. Inside the handler:
   a. Read `boardId` from `mondayBoardPicker.value`; if empty/placeholder,
      show `"Select a board first"` in `#send-monday-status` and return.
   b. Collect checked emails: `allPreviewMessages.filter(m => checkedEmailIds.has(m.id))`
   c. Disable button; clear status; show progress message
   d. Loop over emails:
      - Call `api.createMondayItem(boardId, email.subject)`
      - If item created successfully, call `api.addMondayItemUpdate(itemId, email.bodyText)`
        passing the **full, untruncated** `bodyText` string
      - Collect failures without stopping the loop
   e. Re-enable button; show `✅ N item(s) created on "<BoardName>"` or
      `❌ N failed` summary
3. Keep errors per-item non-fatal — continue the loop, collect any errors,
   report total created + total failed at the end.

**Relevant Context**
- Existing download handler to follow as pattern:
  [`index.html:1657`](electron-outlook/src/renderer/index.html:1657)
- `checkedEmailIds` Set and `allPreviewMessages` array:
  [`index.html:1534`](electron-outlook/src/renderer/index.html:1534)
- `api.createMondayItem`: [`preload.ts:111`](electron-outlook/src/preload.ts:111)
- `api.addMondayItemUpdate`: added in Sub-task 1

**Status** `[x] done`

---

## Implementation Order

Sub-task 1 → Sub-task 2 → Sub-task 3

Each sub-task touches a different layer (backend IPC, HTML structure, JS
logic) and can be validated independently before moving to the next.
