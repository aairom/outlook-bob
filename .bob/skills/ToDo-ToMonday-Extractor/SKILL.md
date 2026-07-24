name: email-action-tracker
description: >
  Use when processing extracted emails (.eml files or email content) to identify every
  actionable item, commitment, request, follow-up, or next step and create structured
  Monday.com parent items + subitems with Outlook links and ownership. Activate when the
  user asks to analyse emails for actions, create action items from emails, triage emails
  into Monday tasks, or process .eml files into Monday with parent items and subitems.
---

# Email Action Tracker Skill

Transform emails into a structured Monday.com action tracker.
For each email: create **one parent item** (email level) and **one subitem per distinct
action** (task level), with direct Outlook links on every row for full traceability.

---

## Step 1 — Gather inputs

Before starting, confirm you have all required inputs. If any are missing, use
`ask_followup_question` to collect them:

| Input | Description | Example |
|---|---|---|
| **EML folder path** (or email content) | Directory with `.eml` files, or raw email text | `output/eml_export_20250701_120000/` |
| **Monday board ID** | Numeric ID of the target board | `1234567890` |
| **Group ID** (optional) | Monday group within the board to create items under | `topics` |

---

## Step 2 — Discover files

Use `execute_command` with `find <folder> -name “*.eml” | sort` to list all `.eml` files.
Create `<eml_folder>/processed/` if it does not exist:

```bash
mkdir -p <eml_folder>/processed
```

---

## Step 3 — Parse each email

For every `.eml` file, use `execute_command` with `cat <file>` to load its raw content
(files are outside the workspace sandbox). Extract:

| Field | Source header | Notes |
|---|---|---|
| `subject` | `Subject:` | Verbatim; use `(no subject)` if blank |
| `from` | `From:` | Full name + email address |
| `to` | `To:` | All recipients |
| `cc` | `Cc:` | All CC’d addresses |
| `date` | `Date:` | Format as `YYYY-MM-DD` |
| `graphMessageId` | `X-Graph-Message-ID:` | Immutable Graph ID — used to build the Outlook desktop deeplink |
| `webLink` | `X-Outlook-Web-Link:` | OWA web link — fallback only |
| `body` | HTML body | Strip all HTML/CSS tags; decode quoted-printable / base64 |

**Build the Outlook link — priority order (desktop app first):**

1. **Preferred — opens Outlook desktop app:**
   ```
   outlook://open?messageId=<X-Graph-Message-ID>
   ```
   The `X-Graph-Message-ID` value does **not** need URL-encoding — it contains only
   alphanumeric characters, hyphens, and underscores.

2. **Fallback — opens OWA in browser:** use `X-Outlook-Web-Link` value as-is.

3. **Last resort:** `outlook://open?messageId=<url-encoded Message-ID>`

> The `X-Graph-Message-ID` header is present in **all EML files exported by this app**.
> Always use option 1. The desktop deeplink must appear on every parent item AND every subitem.

---

## Step 4 — Identify actionable items

Analyse the full email content (subject + body + thread context if available).

### 4a — Extract actions

Create one action entry for **each** of the following detected in the email:

- Explicit tasks, requests, and assignments
- Implicit actions inferable from context
- Follow-ups and waiting-for items
- Commitments and deliverables
- Decisions that require an action
- Open questions requiring a response
- Next steps listed in the email

### 4b — Action trigger keywords (English)

```
Please · Can you · Could you · Action required · Follow up · Next step
Need to · Must · Required before · Waiting for · Review · Approve
Send · Deliver · Schedule · Prepare · Update · Validate · Confirm
```

### 4c — Action trigger keywords (French)

```
Veuillez · Pouvez-vous · Pourriez-vous · Action requise · Suivi à effectuer
Prochaine étape · Nécessité de · Doit / Obligatoire · Requis avant · En attente de
Examiner / Revoir · Approuver / Valider · Envoyer · Livrer / Remettre
Planifier / Organiser · Préparer · Mettre à jour · Valider · Confirmer
Merci de · Merci de bien vouloir · Peux-tu · Pouvez-vous prendre en charge
À faire · Action attendue · Nous avons besoin de · Il faudrait
Merci de confirmer · Merci d’envoyer · Merci de préparer · Merci de planifier
Merci de vérifier · Merci de valider · Merci de relancer
En attente de votre retour · Retour attendu · Réponse requise · Décision à prendre
Point à traiter · À valider avant · À finaliser avant · À soumettre avant
À communiquer au client · À partager avec l’équipe · À escalader si nécessaire
Prochaines actions · Étapes suivantes · Points ouverts · Actions en cours
Actions à clôturer · Délai à respecter · Échéance fixée au
```

### 4d — Contextual inference

Even without trigger keywords, infer actions when context implies one.
**Example:** “John, we need the proposal finalized before Monday for the client presentation.”
→ Action: Owner=John · Task=Finalize proposal before Monday · Client=identified client

### 4e — Exclusion rules

Do **not** create subitems for:
- Pure informational content with no action required
- Historical completed actions
- Email signatures and disclaimers
- Repeated actions already captured from an earlier email in the same thread (dedup)

### 4f — No generic tasks

Never create a subitem titled just “Follow up” or “Reply” without adding specific context:
what exactly to follow up on, with whom, by when.

---

## Step 5 — Determine ownership

For each action, apply this priority order to assign an owner:

1. Explicit assignee named in the email body (“John, please…“, “@Sarah”)
2. Recipient in the `To:` field directly requested to act
3. Primary recipient (first `To:` address) as default
4. Leave blank if ownership cannot be determined

For the parent item owner, use the same priority — the person most responsible for acting
on this email overall.

---

## Step 6 — Identify client / account

Scan the email subject and body for a client or account name:
- Company names, project names, contract references
- Names preceded by “client”, “customer”, “compte”, “for”, “avec”

If no client can be confidently identified, leave `Compte/Client` empty.
Never guess — only populate when clearly present in the email.

---

## Step 7 — Inspect the board then create the Monday parent item

### 7a — Discover column IDs (do this once per board, before creating any items)

Query the main board columns via the Monday MCP or the GraphQL API:

```graphql
{ boards(ids:[<board_id>]) { columns { id title type } } }
```

Then query the **subitem board** (its ID is in the `settings_str` of the `subtasks` column):

```graphql
{ boards(ids:[<subitem_board_id>]) { columns { id title type } } }
```

Map column titles to their IDs. Example from the current board:

| Title | Column ID (main board) | Type |
|---|---|---|
| Email | `link_mm5hpytd` | link |
| Sujet | `text_mm5h7ce5` | text |
| To Do | `long_text_mm5htbge` | long_text |
| Client | `text_mm5hxjna` | text |
| Date | `date4` | date |

| Title | Column ID (subitem board) | Type |
|---|---|---|
| Email | `link_mm5hbtbx` | link |
| Sujet | `text_mm5h4ejd` | text |
| To Do | `long_text_mm5hev1h` | long_text |
| Owner | `text_mm5hp5tc` | text |
| Compte/client | `text_mm5he9ns` | text |
| Date | `date0` | date |

> These IDs are specific to this board. Always re-query if working on a different board.

### 7b — Create the parent item

Use `create_item` with `board_id` and `item_name` (the email subject), then immediately
call `change_multiple_column_values` with:

```json
{
  “<link_col_id>“:      { “url”: “outlook://open?messageId=<X-Graph-Message-ID>“, “text”: “Ouvrir dans Outlook” },
  “<text_sujet_id>“:    “<email subject>“,
  “<long_text_todo_id>“: { “text”: “<2–4 sentence summary of all actions>” },
  “<text_client_id>“:   “<client name or empty string>“,
  “<date_col_id>“:      { “date”: “YYYY-MM-DD” }
}
```

---

## Step 8 — Create subitems

For **each action** identified in Step 4, create one subitem under the parent via
`create_subitem` with `parent_item_id` and `item_name` (short actionable title, max 80 chars).

Then immediately call `change_multiple_column_values` on the **subitem board** with:

```json
{
  “<link_col_id>“:       { “url”: “outlook://open?messageId=<X-Graph-Message-ID>“, “text”: “Ouvrir dans Outlook” },
  “<text_sujet_id>“:     “<short actionable title>“,
  “<text_owner_id>“:     “<action owner — full name>“,
  “<long_text_todo_id>“: { “text”: “<specific task description>” },
  “<text_client_id>“:    “<client name or empty string>”
}
```

**Owner field — use the subitem board’s `text` Owner column** (not a `people` column).
Write the full name of the person responsible for this specific action.

### Subitem title examples (good vs bad)

| :white_check_mark: Good | :x: Bad |
|---|---|
| Prepare proposal for client review | Follow up |
| Schedule architecture workshop before Friday | Task |
| Validate pricing assumptions and send to Sarah | Do something |
| Send signed contract to procurement | Reply |

---

## Step 9 — Move processed file

After all subitems are created for an email, move the `.eml` file to `processed/`:

```bash
mv “<eml_file_path>” “<eml_folder>/processed/”
```

Only move the file after **all** Monday API calls for that email have succeeded.
If any call fails, leave the file in the source folder for retry.

---

## Step 10 — Progress reporting

After each email, print inline:

```
:white_check_mark: [N/Total] <subject> → parent item <id> · <K> subitems created
```

---

## Step 11 — Final summary

After all files are processed, output a table:

| # | File | Subject | Parent Item ID | Subitems | Status |
|---|---|---|---|---|---|
| 1 | email1.eml | Re: Contract review | 123456 | 3 | :white_check_mark: |
| 2 | email2.eml | Q3 project update | 789012 | 1 | :white_check_mark: |
| 3 | email3.eml | FYI: team outing | — | 0 | :black_right_pointing_double_triangle_with_vertical_bar: No actions |
| 4 | email4.eml | Urgent: deliverable | — | — | :x: Error: … |

---

## Error handling

- If an email has **no actionable items**, skip it (no parent item created). Log it as
  `:black_right_pointing_double_triangle_with_vertical_bar: No actions` in the summary.
- If a file cannot be read, log the error and continue with the next file.
- If a Monday `create_item` call fails, log the error, do **not** create subitems, do
  **not** move the file, and continue.
- If a `create_subitem` call fails after the parent was created, log the error and continue
  with remaining subitems. Do **not** move the file.
- At the end, list all files that failed so the user can retry.

---

## Quality checklist (apply to every email)

- [ ] Every actionable item has exactly one subitem
- [ ] No two subitems describe the same action (dedup)
- [ ] Every subitem title is specific and business-oriented (not generic)
- [ ] Outlook link is present on both parent item and every subitem
- [ ] Owner is assigned where determinable
- [ ] `Compte/Client` is only populated when clearly identified in the email
- [ ] No content is invented — all fields are grounded in the email text

---

## Notes

- Run in **Agent mode** — all tools (read_file, execute_command, Monday MCP) must be available.
- The Monday API token is read automatically from `.bob/mcp.json`.
- The `processed/` subfolder is created inside the source EML folder.
- Prompt files in `prompts/` are gitignored — they stay local.
- If called without an EML folder (e.g. user pastes raw email text), skip Steps 2–3 and
  apply Steps 4–11 directly to the provided content.
