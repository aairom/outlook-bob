---
name: ecosystem-partner-workflow
description: >
  Use when an IBM seller or tech-seller wants to manage IBM Ecosystem Business Partner
  relationships - covers any of the 6 AI-augmented workflows: listing open partner
  actions, preparing a meeting brief, updating the board after a call (post-call /
  MoM processing), drafting badge/training nudge messages, writing a partner email,
  or producing a weekly squad digest. Activate whenever the user mentions a partner
  name or asks about priorities, a meeting brief, a post-call update, badge nudges,
  or a partner email in the IBM Ecosystem context.
---

# IBM Ecosystem Partner Workflow Skill

Activate this skill to execute any of the 6 AI-augmented seller workflows defined
in the IBM Ecosystem AI Productivity architecture. All workflows read from and write
to two Monday.com boards via the monday MCP server:

- **Projects board** - All Partners · Customer Projects
- **Training board** - All Partners · Training & Badges

**Golden rule:** The IBMer always reviews before anything is written. Propose a
clear diff (CREATE / UPDATE / DISCARD) and wait for explicit approval before calling
any write MCP tool.

---

## Step 0 - Identify the workflow

Ask the user (via `ask_followup_question`) which workflow they need if it is not
clear from the prompt:

1. **List open actions & priorities** - consolidated to-do across all partners
2. **Meeting brief** - preparation note before a partner meeting
3. **Post-call / MoM update** - extract actions from transcript or notes and update the board
4. **Training & badge nudge** - draft nudge messages for incomplete badges
5. **Partner email** - structured partner-facing email from board data
6. **Weekly squad digest** - aggregate cross-partner status summary

If the user's prompt already identifies one workflow clearly, proceed directly to
the matching section below without asking.

---

## Workflow 1 - List Open Actions & Priorities

**Trigger phrases:** "open actions for…", "what's overdue for…", "priority list", "action list", "what do I need to do for…"

### Steps

1. Ask for the **partner name** (or "all partners" for a full view) if not in the prompt.
2. Call `mcp__monday__get_board_items_page` on the **Projects board**, filtering by:
   - `Partner` column = partner name (skip if "all partners")
   - `Status` column ≠ `Done` / `Completed`
   - Order by `Due Date` ascending
3. Call `mcp__monday__get_board_items_page` on the **Training board**, same filters.
4. Merge results. Group into three buckets:
   - **Overdue** (due date in the past)
   - **Due this week**
   - **Upcoming** (due within 30 days)
   - **Blocked** (status = Blocked / Stuck)
5. Present a ranked list with item name, partner, due date, status, and next step.
6. Ask the user if they want to act on any item before closing.

---

## Workflow 2 - Meeting Brief

**Trigger phrases:** "prepare a brief for…", "meeting with… on…", "briefing note", "I have a call with…", "prepare for my meeting"

### Steps

1. Confirm the **partner name** and **meeting date** (or "today" / "Thursday", etc.).
2. Call `mcp__monday__get_board_items_page` on the **Projects board** filtered to this partner, status ≠ Done, ordered by due date.
3. Call `mcp__monday__get_board_items_page` on the **Training board** filtered to this partner, status ≠ Completed.
4. For each Projects item with recent activity, call `mcp__monday__get_updates` to surface the latest comments/notes.
5. Generate the meeting brief with these sections:
   - **Open Opportunities / Actions** - table of item, stage, due date, next step
   - **Badge & Training Status** - per contact: badge, % complete, target date, blocker
   - **Recent Updates** - last comment on top items (with date)
   - **Suggested Talking Points** - 3–5 AI-generated action-oriented agenda items
   - **Items Needing a Decision** - flagged blocked or "In Review" items
6. Present the brief as formatted markdown. Offer to update an item status or add a comment if the user wants.

---

## Workflow 3 - Post-Call / MoM Update

**Trigger phrases:** "update the board after…", "here is the MoM", "here are my notes from…", "post-call update", "transcript from today's call"

### Steps

1. Ask the user to **paste or provide** the meeting transcript, Minutes of Meeting, or notes if not already supplied in the prompt.
2. Ask for the **partner name** so queries can be scoped.
3. Read the current board state: call `mcp__monday__get_board_items_page` on both boards filtered by partner.
4. Analyse the source text with LLM reasoning to extract:
   - Action items (new or updated): item title, owner, due date, status change
   - Decisions made
   - Blockers mentioned
5. For each extracted item, determine whether it maps to an **existing board item** (UPDATE) or is **new** (CREATE). Flag any that cannot be matched as REVIEW.
6. Present the full proposed diff to the IBMer:
   ```
   UPDATE  "QRadar demo follow-up"  → Status: In Progress | Due: Aug 5
   CREATE  "CP4D license confirmation"  | Partner: Partner 1 | Due: Aug 1
   DISCARD "Scheduling logistics"  (ADMIN, no board action needed)
   ```
7. Wait for the IBMer to approve, edit, or discard each item.
8. For each **approved** item:
   - UPDATE → call `mcp__monday__change_item_column_values` with the changed fields
   - CREATE → call `mcp__monday__create_item` with extracted field values
   - For all written items, call `mcp__monday__create_update` to add a comment:
     `"Updated via MoM - [source doc title] - [date]"` for traceability.
9. Confirm the write summary to the user.

---

## Workflow 4 - Training & Badge Progress Nudge

**Trigger phrases:** "badge nudge", "training nudge", "incomplete badges for…", "who hasn't finished their badge", "training update for…"

### Steps

1. Ask for the **partner name** (or "all partners") if not in the prompt.
2. Call `mcp__monday__get_board_items_page` on the **Training board** with filters:
   - Partner = partner name
   - Status ≠ Completed
   - Due date within the next 30 days (or all incomplete if no target date set)
3. Group results by partner contact. For each contact with incomplete badges:
   - List badge name, % complete, target date, blocker field
4. Draft a personalised nudge message per contact:
   - Professional, encouraging tone
   - Name the specific badge(s) outstanding
   - Include the target date
   - If a blocker is recorded (e.g. "lab access"), name it and suggest the resource link if known
   - Recommend a start-by date if the badge has 0% progress
5. Present all drafts to the IBMer for review and editing before use.
6. Ask if the IBMer wants to update any `Status` or `Blocker` field on the board after reviewing.

---

## Workflow 5 - Partner Email

**Trigger phrases:** "draft an email for…", "partner email", "summary email to…", "email with all actions for…", "prepare an email for Partner…"

### Steps

1. Ask for the **partner name** and **tone** (formal / semi-formal) if not in the prompt.
2. Call `mcp__monday__get_board_items_page` on the **Projects board**, filtered by partner, status ≠ Done, ordered by due date.
3. Call `mcp__monday__get_board_items_page` on the **Training board**, filtered by partner, status ≠ Completed.
4. Categorise items into:
   - **⚑ Due this month** - high urgency
   - **Upcoming** - due within 60 days
   - **Blocked / Needs attention** - status = Blocked or flagged
   - **Training status** - per badge
5. Draft the email:
   - Subject: `[IBM] Partner Action Summary - [Month Year]`
   - Opening: 1-sentence context based on relationship (extract from board update history if available)
   - Body: structured sections per category above
   - Closing: call to action - confirm receipt of action items, propose next meeting if overdue items exist
6. Present the draft to the IBMer. Wait for approval before any send action.
7. If the IBMer approves:
   - Save the approved email as an **`.eml` file** to `data/<partner-name>/AI-Emails-Suggestions/` using `write_file`:
     - Filename: `[YYYY-MM-DD] [Subject line].eml`
     - Example: `data/techpartner-france/AI-Emails-Suggestions/2026-07-18 IBM Partner Action Summary - July 2026.eml`
   - EML format: double-clicking the file opens it directly in Outlook as a ready-to-send draft.
   - Use the following EML structure (MIME multipart with plain-text fallback and HTML body):

     ```
     From: [sender]
     To: [recipient]
     Subject: [subject]
     MIME-Version: 1.0
     Content-Type: multipart/alternative; boundary="boundary_ibmbob"
     X-IBM-Bob: AI-generated email suggestion

     --boundary_ibmbob
     Content-Type: text/plain; charset=UTF-8

     [plain-text version of the email body]

     --boundary_ibmbob
     Content-Type: text/html; charset=UTF-8

     [full HTML body with inline CSS tables - no <script>, no external assets]

     --boundary_ibmbob--
     ```

   - The HTML part must render tables with inline styles (border, padding, font) since
     Outlook strips `<style>` blocks - use `style="..."` on every `<table>`, `<th>`, `<td>`.
   - Confirm the file was saved:
     `✓ Saved: data/<partner-name>/AI-Emails-Suggestions/<filename>`

> **Note:** The `AI-Emails-Suggestions/` sub-folder is created automatically by `write_file` if it does not exist.
> Saved emails are intentionally **not** prefixed `ECOSYSTEM-AI-4-PROD` - they are outputs, not
> inputs, and must never be picked up by the partner-data-ingest scanner.

---

## Workflow 6 - Weekly Squad Digest

**Trigger phrases:** "weekly digest", "squad summary", "dashboard update", "all-partner status", "manager report"

### Steps

1. Call `mcp__monday__board_insights` on the **Projects board** with aggregations:
   - Count of items by `Status`
   - Count of overdue items (due date < today, status ≠ Done)
   - Count of items in "Needs Review" group
2. Call `mcp__monday__board_insights` on the **Training board** with aggregations:
   - Count of items by `Status` grouped by `Partner`
   - Count of items with `Completion %` = 0
   - Count blocked items
3. Compose a narrative digest:
   ```
   Week of [date]
   Projects: X open, Y overdue, Z in review
   Training: X incomplete badges across N partners, Y blocked
   Spotlight: [most urgent item or partner]
   No-action items: [list if any unassigned >7 days]
   ```
4. Call `mcp__monday__create_update` on the Projects board item (or a dedicated "Digest" item if one exists) to post the digest as a board comment for team visibility.
5. Present the digest to the user and confirm it was posted.

> **Phase note:** Full automation of the weekly digest (scheduled trigger) is a Phase 2/3 capability via watsonx Orchestrate. In Phase 1 / Bob, trigger this on demand.

---

## Board field reference (quick lookup)

### Projects Board columns
| Field | Monday column type | Notes |
|---|---|---|
| Opportunity / Action | Item name (text) | AI-generated title |
| Partner | Dropdown | Filter key |
| End Customer | Text | Final customer |
| Stage | Status | e.g. In Progress, In Review, Done |
| IBM Technology | Dropdown | e.g. watsonx, QRadar, CP4D |
| Partner Contact | Text / Email | Extracted from emails or attendees |
| Next Step | Long text | AI-summarised action |
| Due Date | Date | Used for urgency ranking |
| IBM Owner | People | Assigned IBMer |

### Training Board columns
| Field | Monday column type | Notes |
|---|---|---|
| Badge / Certification | Item name (text) | |
| Partner | Dropdown | Filter key |
| Partner Contact | Text / Email | Person completing the badge |
| IBM Technology Domain | Group | watsonx & AI · Security · Automation… |
| Completion % | Numbers | 0–100 |
| Target Date | Date | Certification deadline |
| Status | Status | Not Started · In Progress · Blocked · Completed |
| Blocker | Long text | Free-text reason |
