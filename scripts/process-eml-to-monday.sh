#!/usr/bin/env bash
# =============================================================================
# process-eml-to-monday.sh
#
# Usage:
#   bash scripts/process-eml-to-monday.sh \
#     --folder  <path-to-eml-folder> \
#     --prompt  <path-to-prompt-file> \
#     --board   <monday-board-id>
#
# What it does:
#   1. Validates all three required arguments
#   2. Confirms the .eml folder and prompt file exist
#   3. Creates a `processed/` subfolder inside the EML folder
#   4. Lists all .eml files found (recursively)
#   5. Prints a ready-to-copy instruction for Bob to process them
#
# Actual LLM processing + Monday API calls are performed by Bob (Agent mode)
# using the eml-to-monday skill.  This script is a helper to validate inputs
# and hand off cleanly to Bob.
# =============================================================================

set -euo pipefail

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}ℹ️  $*${RESET}"; }
success() { echo -e "${GREEN}✅ $*${RESET}"; }
warn()    { echo -e "${YELLOW}⚠️  $*${RESET}"; }
error()   { echo -e "${RED}❌ $*${RESET}" >&2; }

# ── Parse arguments ───────────────────────────────────────────────────────────
EML_FOLDER=""
PROMPT_FILE=""
BOARD_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --folder) EML_FOLDER="$2"; shift 2 ;;
    --prompt) PROMPT_FILE="$2"; shift 2 ;;
    --board)  BOARD_ID="$2";   shift 2 ;;
    *)
      error "Unknown argument: $1"
      echo "Usage: bash scripts/process-eml-to-monday.sh --folder <path> --prompt <file> --board <id>"
      exit 1
      ;;
  esac
done

# ── Validate required arguments ───────────────────────────────────────────────
MISSING=0
[[ -z "$EML_FOLDER"  ]] && { error "Missing --folder argument (path to .eml directory)"; MISSING=1; }
[[ -z "$PROMPT_FILE" ]] && { error "Missing --prompt argument (path to prompt markdown file)"; MISSING=1; }
[[ -z "$BOARD_ID"    ]] && { error "Missing --board argument (Monday board ID)"; MISSING=1; }
[[ "$MISSING" -eq 1  ]] && { echo ""; echo "Usage: bash scripts/process-eml-to-monday.sh --folder <path> --prompt <file> --board <id>"; exit 1; }

# ── Validate paths ────────────────────────────────────────────────────────────
if [[ ! -d "$EML_FOLDER" ]]; then
  error "EML folder not found: $EML_FOLDER"
  exit 1
fi

if [[ ! -f "$PROMPT_FILE" ]]; then
  error "Prompt file not found: $PROMPT_FILE"
  exit 1
fi

# ── Count .eml files ──────────────────────────────────────────────────────────
EML_COUNT=$(find "$EML_FOLDER" -name "*.eml" ! -path "*/processed/*" | wc -l | tr -d ' ')

if [[ "$EML_COUNT" -eq 0 ]]; then
  warn "No .eml files found in: $EML_FOLDER"
  warn "Nothing to process."
  exit 0
fi

# ── Create processed/ subfolder ───────────────────────────────────────────────
PROCESSED_DIR="${EML_FOLDER%/}/processed"
mkdir -p "$PROCESSED_DIR"
success "processed/ folder ready: $PROCESSED_DIR"

# ── Print summary ─────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  EML → Monday — Pre-flight check${RESET}"
echo -e "${BOLD}═══════════════════════════════════════════════════════${RESET}"
echo ""
info "EML folder  : $EML_FOLDER"
info "Prompt file : $PROMPT_FILE"
info "Board ID    : $BOARD_ID"
info "Files found : $EML_COUNT .eml file(s)"
info "Output dir  : $PROCESSED_DIR"
echo ""

# ── List files ────────────────────────────────────────────────────────────────
echo -e "${BOLD}Files to process:${RESET}"
find "$EML_FOLDER" -name "*.eml" ! -path "*/processed/*" | sort | while read -r f; do
  echo "  • $(basename "$f")"
done
echo ""

# ── Bob handoff instruction ───────────────────────────────────────────────────
echo -e "${BOLD}═══════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  Next step — paste this into Bob (Agent mode):${RESET}"
echo -e "${BOLD}═══════════════════════════════════════════════════════${RESET}"
echo ""
echo -e "${CYAN}Process the .eml files in \"${EML_FOLDER}\" using the prompt"
echo -e "in \"${PROMPT_FILE}\" and send each one to Monday board ID ${BOARD_ID}."
echo -e "Move each processed file to the processed/ subfolder.${RESET}"
echo ""
success "Pre-flight complete. Hand off to Bob to run the triage."
