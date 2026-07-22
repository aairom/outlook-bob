---
name: eml-to-monday
description: >
  Process .eml files from a folder using a prompt file, create Monday.com items
  for each email, and move processed files to a `processed/` subfolder.
  Activate when the user asks to process, triage, or send .eml files to Monday.
---

# EML → Monday Processing Skill

## Trigger phrases

Activate this skill when the user says things like:
- "process the .eml files in [folder]"
- "send .eml emails to Monday board [ID]"
- "triage emails from [folder] using [prompt]"
- "process exported emails and create Monday items"

---

## Step-by-step workflow

### 1. Gather inputs

Confirm you have all three required inputs before starting. If any are missing, ask:

| Input | Description | Example |
|---|---|---|
| **EML folder path** | Directory containing `.eml` files to process | `output/eml_export_20250701_120000/` |
| **Prompt file path** | Optional markdown file with extraction instructions | `prompts/email-triage.md` |
| **Monday board ID** | Numeric ID of the target Monday board | `1234567890` |

### 2. Read the prompt file

If a prompt file path is provided, use `read_file` to load the prompt instructions from that file.
If no prompt file path is provided, use [`.bob/skills/eml-to-monday.md`](.bob/skills/eml-to-monday.md) as the default prompt content.

### 3. Discover .eml files

Use `execute_command` with `find <folder> -name "*.eml" | sort` to get the full list of
`.eml` files to process (searches recursively through subfolders).

### 4. Create the `processed/` subfolder

Use `execute_command` to create `<eml_folder>/processed/` if it does not already exist:
```bash
mkdir -p <eml_folder>/processed
```

### 5. Process each .eml file

For every `.eml` file found:

1. **Read the file** with `read_file`
2. **Apply the prompt instructions** to extract structured data (item name, sender, date,
   urgency, category, summary, action items)
3. **Create the Monday item** via the Monday MCP server tool `create_item` with:
   - `board_id`: the provided board ID
   - `item_name`: the extracted item name (email subject)
4. **Post the update note** via `create_update` with the formatted note body
5. **Move the file** to `processed/` with:
   ```bash
   mv "<eml_file_path>" "<eml_folder>/processed/"
   ```
6. **Report progress** inline: `✅ [N/Total] <subject> → Monday item <id>`

### 6. Report completion

After all files are processed, output a summary table:

| # | File | Monday Item ID | Status |
|---|---|---|---|
| 1 | filename.eml | 123456 | ✅ Created |
| 2 | filename2.eml | — | ❌ Error: … |

---

## Error handling

- If a file cannot be read, log the error and continue with the next file.
- If a Monday API call fails, log the error, **do not move the file**, and continue.
- Files that failed Monday creation remain in the source folder (not moved to `processed/`).
- At the end, list any files that were not processed so the user can retry.

---

## Notes

- The `prompts/` folder is gitignored — prompt files are local and private.
- The `processed/` subfolder is created inside the source EML folder.
- Monday API token is read from `.bob/mcp.json` automatically.
- Run from Agent mode so all tools (read, execute, MCP) are available.
