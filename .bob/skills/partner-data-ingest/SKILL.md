---
name: partner-data-ingest
description: >
  Use when the user wants to process new partner documents (emails, transcripts,
  PDFs, MoM files, etc.) dropped into a data/partner-name folder - scans all
  partner sub-folders, detects unprocessed files, and classifies each document
  as PROJECT, TRAINING, ADMIN, or MIXED before any board update is made.
  Activate whenever the user says "process partner data", "scan partner files",
  "I dropped a file", "new documents to process", or mentions a file in a
  data/ folder.
---

# Partner Data Ingest - Document Scan & Classify

This skill is **Step 1** of the IBM Ecosystem partner-data pipeline.  
It scans `data/` sub-folders for unprocessed files, asks the user which
partners to process, classifies every file with LLM reasoning, and prepares
a structured **processing manifest** that downstream workflows (board updates,
training nudges, etc.) can act on.

**Processed files** are renamed with the prefix `ECOSYSTEM-AI-4-PROD` and
moved to `data/<partner-name>/processed/` so they are never picked up twice.

---

## Step 0 - Scan all partner data folders

Run the bundled helper script to discover which partners have unprocessed
files. Execute:

```
node .bob/skills/partner-data-ingest/scan-partner-data.js
```

The script prints a JSON array of objects:

```json
[
  {
    "partner": "Partner 1",
    "folder": "data/Partner 1",
    "unprocessed": ["email-2025-07-10.eml", "MoM-July.docx"]
  }
]
```

If the script errors (Node.js not available, `data/` folder missing, etc.),
fall back to using `list_files` on each sub-folder of `data/` and identify
files that do **not** start with `ECOSYSTEM-AI-4-PROD`.

---

## Step 1 - Ask the user which partners to process

If the scan returns **zero** partners with unprocessed files, tell the user
there is nothing new to process and stop.

If one or more partners have new files, use `ask_followup_question` to
present the list and ask:

> "New files were detected for the following partners. Which ones do you
> want to process now?"
> Suggestions: individual partner names + "All of the above" + "None / cancel"

Wait for the user's answer before proceeding. Only process the partners the
user selected.

---

## Step 2 - Read and classify each unprocessed file

For each selected partner, and for each unprocessed file in their folder:

### 2a - Read the file content

Use `read_file` to read the file. If the file is a `.pdf`, `.docx`, or
`.xlsx`, Bob will render its content automatically. For `.eml` / `.txt` /
`.md`, read as plain text.

### 2b - Classify the document

Apply LLM reasoning to assign **exactly one** of these four labels:

| Label | Meaning |
|---|---|
| **PROJECT** | IBM technology opportunity sold by a partner to a customer - sales, demos, PoCs, proposals, deal updates |
| **TRAINING** | Partner staff completing IBM certifications, badges, or learning paths |
| **ADMIN** | Administrative noise - scheduling emails, OOO, IBM newsletters, NDA admin, duplicate threads with no new actionable signal |
| **MIXED** | Document spans more than one domain (e.g. both a deal update and a badge completion) |

**Classification rules:**
- A document is ADMIN only if it contains **no** actionable PROJECT or
  TRAINING signal whatsoever.
- A document is MIXED only if it contains clear, separable PROJECT **and**
  TRAINING content. A document with a minor badge mention inside a deal
  thread is still PROJECT (dominant signal wins).
- When in doubt between PROJECT and TRAINING, choose the label whose content
  occupies the majority of the document.

### 2c - Handle MIXED documents

For every MIXED document, **split it into sub-documents** in memory - do not
write new files to disk at this stage. Create one logical sub-document per
domain:

```
email-Jul-10.eml  →  sub-doc A: PROJECT content extracted
                      sub-doc B: TRAINING content extracted
```

Each sub-document is then classified and processed independently as if it
were a standalone file.

---

## Step 3 - Build the processing manifest

Construct a manifest table for the user's review before any file is moved
or any board is updated:

```
Partner 1
─────────────────────────────────────────────────────────────────
File                    │ Label     │ Summary (≤15 words)
MoM-July.docx           │ PROJECT   │ QRadar PoC agreed, next step: lab provisioning
email-2025-07-10.eml    │ TRAINING  │ Fatima completed watsonx.ai badge, 100%
newsletter-IBM-Q3.pdf   │ ADMIN     │ IBM Q3 newsletter, no partner action required
kickoff-notes.txt       │ MIXED     │ Split → deal signed (PROJECT) + badge plan (TRAINING)
─────────────────────────────────────────────────────────────────
```

**For each MIXED file**, list the split sub-documents as indented child rows
below the parent row, each with its own label and summary.

Present the full manifest and ask:

> "Does this classification look correct? You can ask me to reclassify any
> file, or approve all to continue."

Wait for explicit approval. Adjust any files the user disputes and regenerate
their rows before proceeding.

---

## Step 4 - Mark files as processed

After the user approves the manifest, for each file in the manifest
(original files only - not logical sub-documents):

1. Determine the destination path:
   `data/<partner-name>/processed/ECOSYSTEM-AI-4-PROD-<original-filename>`
2. Use `execute_command` to move and rename the file:
   ```powershell
   New-Item -ItemType Directory -Force -Path "data/<partner-name>/processed"
   Move-Item -Path "data/<partner-name>/<filename>" `
             -Destination "data/<partner-name>/processed/ECOSYSTEM-AI-4-PROD-<filename>"
   ```
3. Confirm the move succeeded before logging it.

Log each move as a single-line summary:
```
✓ Moved: MoM-July.docx → data/Partner 1/processed/ECOSYSTEM-AI-4-PROD-MoM-July.docx
```

---

## Step 5 - Ensure board groups exist (Projects board)

Before creating any PROJECT item on the **Projects board**, ensure a group
named `<PartnerName> - <EndCustomer>` exists for each unique
Partner + End Customer pair in the approved manifest.

### 5a - Check existing groups

Call `mcp__monday__get_board_info` on the Projects board and inspect the
`groups` array. For each PROJECT item to be created, derive the expected
group title:

```
<Partner folder name> - <End Customer extracted from document>
```

Examples:
- `techpartner-france - GreenCarbon Foods SA`
- `techpartner-france - TransMobil Logistics Group`

### 5b - Create missing groups

For each expected group title that does **not** already exist in the board,
call `mcp__monday__create_group`:

```
boardId:    <Projects board ID>
groupName:  "<PartnerName> - <EndCustomer>"
groupColor: #579bfc   (consistent blue for all partner groups)
```

Note the returned `group_id` for use in the next step.

### 5c - Create items in the correct group

When calling `mcp__monday__create_item`, always pass `groupId` set to the
`group_id` of the matching `<PartnerName> - <EndCustomer>` group.

**Never create PROJECT items in "Unassigned / Needs Review"** - that group
is only for items that could not be matched to a partner + customer pair.
Use it only if the End Customer cannot be determined from the document.

### 5d - Move existing items if needed

If items were already created in the wrong group (e.g. during a previous
run), move them using:

```graphql
mutation {
  move_item_to_group(item_id: <item_id>, group_id: "<correct_group_id>") {
    id
  }
}
```

Call this via `mcp__monday__all_api_write`.

---

## Step 6 - Hand off to downstream workflows

After all files are moved and all board items are in the correct groups,
present the approved manifest items that are **not ADMIN** and ask the user
what they want to do next:

- **PROJECT items** → offer to trigger `ecosystem-partner-workflow` Workflow 3
  (Post-call / MoM Update) using the classified content already in memory.
- **TRAINING items** → offer to trigger `ecosystem-partner-workflow` Workflow 4
  (Training & Badge Nudge) using the extracted badge information.
- **ADMIN items** → no board action. Confirm they are discarded.

If the user confirms, activate the relevant downstream workflow and pass the
extracted content so no re-reading is required.

---

## Error handling

| Situation | Action |
|---|---|
| `data/` folder does not exist | Tell the user. Suggest creating `data/<partner-name>/` and dropping files there. Stop. |
| File cannot be read (binary, corrupted) | Mark it `UNREADABLE` in the manifest. Ask user to inspect it manually. Continue with other files. |
| Only ADMIN files detected for a partner | Still present them in the manifest (so the user can override), but note they require no board action. |
| User selects "None / cancel" at Step 1 | Acknowledge and stop gracefully. |
| End Customer cannot be determined from document | Create item in "Unassigned / Needs Review" group and flag status as `Needs Review`. Do not guess the customer name. |
| Group creation fails (permissions, etc.) | Report the error. Create the item in "Unassigned / Needs Review" as a fallback and note the intended group in the Next Step field. |
| IBM Technology label does not exist in the dropdown | See Step 5e below - always add the label via a dummy item, then **immediately clear that item's dropdown field**, before creating the real item. |

---

## Step 5e - Adding a missing IBM Technology dropdown label (safe procedure)

The `create_item` and `change_item_column_values` tools do **not** support
`createLabelsIfMissing` for Dropdown columns. The only way to add a new label
is to call `change_column_value` with `create_labels_if_missing: true` via
`mcp__monday__all_api_write` - but this mutation also **sets the dropdown
value on the item you pass**, which will corrupt that item's IBM Technology
field if you reuse a real item.

### Safe procedure

1. **Create a temporary scratch item** in the "Unassigned / Needs Review"
   group with only a name (no column values):

   ```graphql
   mutation {
     create_item(board_id: <boardId>, group_id: "group_mm5b1a65",
                 item_name: "_label_seed") { id }
   }
   ```

2. **Add the missing label using that scratch item**:

   ```graphql
   mutation {
     change_column_value(
       board_id: <boardId>,
       item_id: <scratch_item_id>,
       column_id: "dropdown_mm59g1qx",
       value: "{\"labels\":[\"<NewLabel>\"]}",
       create_labels_if_missing: true
     ) { id }
   }
   ```

3. **Delete the scratch item immediately**:

   ```graphql
   mutation {
     delete_item(item_id: <scratch_item_id>) { id }
   }
   ```

4. The label now exists in the column. Proceed to create the real item
   using `mcp__monday__create_item` with the new label value - it will
   resolve correctly.

> ⚠️ **Never use an existing real item as the vehicle for label creation.**
> The `change_column_value` mutation sets the dropdown on that item as a
> side effect, silently overwriting its IBM Technology value.

---

## Folder conventions (reference)

```
data/
  Partner 1/
    email-2025-07-10.eml          ← unprocessed (picked up by this skill)
    MoM-July.docx                 ← unprocessed
    processed/
      ECOSYSTEM-AI-4-PROD-...     ← already handled, ignored by scanner
  Partner 2/
    ...
```

- Partner folder names are **case-sensitive** and must match the `Partner`
  dropdown value on the Monday.com boards exactly.
- The `processed/` sub-folder is created automatically by this skill if it
  does not already exist.
- Files already prefixed `ECOSYSTEM-AI-4-PROD` are always skipped by the
  scanner, regardless of which sub-folder they sit in.
