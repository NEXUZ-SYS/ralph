#!/bin/bash
# Ralph Wiggum - Long-running AI agent loop
# Usage: ./ralph.sh [--tool amp|claude] [--auto-handoff] [max_iterations]

set -e

# Parse arguments
TOOL="amp"  # Default to amp for backwards compatibility
MAX_ITERATIONS=10
AUTO_HANDOFF=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --tool)
      TOOL="$2"
      shift 2
      ;;
    --tool=*)
      TOOL="${1#*=}"
      shift
      ;;
    --auto-handoff)
      AUTO_HANDOFF=true
      shift
      ;;
    *)
      # Assume it's max_iterations if it's a number
      if [[ "$1" =~ ^[0-9]+$ ]]; then
        MAX_ITERATIONS="$1"
      fi
      shift
      ;;
  esac
done

# Validate tool choice
if [[ "$TOOL" != "amp" && "$TOOL" != "claude" ]]; then
  echo "Error: Invalid tool '$TOOL'. Must be 'amp' or 'claude'."
  exit 1
fi
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRD_FILE="$SCRIPT_DIR/prd.json"
PROGRESS_FILE="$SCRIPT_DIR/progress.txt"
ARCHIVE_DIR="$SCRIPT_DIR/archive"
LAST_BRANCH_FILE="$SCRIPT_DIR/.last-branch"
HANDOFF_DIR="$SCRIPT_DIR/handoff"
HOOKS_DIR="$SCRIPT_DIR/.claude/hooks/auto-handoff"

# Setup auto-handoff hooks for Claude Code
setup_auto_handoff() {
  local settings_file="$SCRIPT_DIR/.claude/settings.local.json"

  # Create .claude directory if needed
  mkdir -p "$SCRIPT_DIR/.claude"
  mkdir -p "$HANDOFF_DIR"

  # Write hooks configuration to settings.local.json (gitignored)
  cat > "$settings_file" << 'SETTINGS_EOF'
{
  "hooks": {
    "PreCompact": [
      {
        "matcher": "auto",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/auto-handoff/precompact-save.mjs\"",
            "async": true,
            "timeout": 30
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "compact",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/auto-handoff/session-restore.mjs\"",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/auto-handoff/stop-handoff.mjs\"",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
SETTINGS_EOF

  echo "Auto-handoff hooks configured in $settings_file"
}

# Clean up old handoff documents between iterations
cleanup_handoffs() {
  if [ -d "$HANDOFF_DIR" ]; then
    # Keep only the latest handoff
    local count=$(ls -1 "$HANDOFF_DIR"/handoff-*.md 2>/dev/null | wc -l)
    if [ "$count" -gt 5 ]; then
      ls -1t "$HANDOFF_DIR"/handoff-*.md | tail -n +6 | xargs rm -f 2>/dev/null || true
    fi
  fi
}

# Archive previous run if branch changed
if [ -f "$PRD_FILE" ] && [ -f "$LAST_BRANCH_FILE" ]; then
  CURRENT_BRANCH=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
  LAST_BRANCH=$(cat "$LAST_BRANCH_FILE" 2>/dev/null || echo "")

  if [ -n "$CURRENT_BRANCH" ] && [ -n "$LAST_BRANCH" ] && [ "$CURRENT_BRANCH" != "$LAST_BRANCH" ]; then
    # Archive the previous run
    DATE=$(date +%Y-%m-%d)
    # Strip "ralph/" prefix from branch name for folder
    FOLDER_NAME=$(echo "$LAST_BRANCH" | sed 's|^ralph/||')
    ARCHIVE_FOLDER="$ARCHIVE_DIR/$DATE-$FOLDER_NAME"

    echo "Archiving previous run: $LAST_BRANCH"
    mkdir -p "$ARCHIVE_FOLDER"
    [ -f "$PRD_FILE" ] && cp "$PRD_FILE" "$ARCHIVE_FOLDER/"
    [ -f "$PROGRESS_FILE" ] && cp "$PROGRESS_FILE" "$ARCHIVE_FOLDER/"
    echo "   Archived to: $ARCHIVE_FOLDER"

    # Reset progress file for new run
    echo "# Ralph Progress Log" > "$PROGRESS_FILE"
    echo "Started: $(date)" >> "$PROGRESS_FILE"
    echo "---" >> "$PROGRESS_FILE"

    # Clean up handoffs from previous run
    rm -rf "$HANDOFF_DIR"/*.md 2>/dev/null || true
  fi
fi

# Track current branch
if [ -f "$PRD_FILE" ]; then
  CURRENT_BRANCH=$(jq -r '.branchName // empty' "$PRD_FILE" 2>/dev/null || echo "")
  if [ -n "$CURRENT_BRANCH" ]; then
    echo "$CURRENT_BRANCH" > "$LAST_BRANCH_FILE"
  fi
fi

# Initialize progress file if it doesn't exist
if [ ! -f "$PROGRESS_FILE" ]; then
  echo "# Ralph Progress Log" > "$PROGRESS_FILE"
  echo "Started: $(date)" >> "$PROGRESS_FILE"
  echo "---" >> "$PROGRESS_FILE"
fi

# Setup auto-handoff if requested and using Claude
if [[ "$AUTO_HANDOFF" == true ]]; then
  if [[ "$TOOL" != "claude" ]]; then
    echo "Note: --auto-handoff is for Claude Code. For Amp, use amp.experimental.autoHandoff in settings."
    echo "Continuing without auto-handoff hooks..."
  else
    if [ -d "$HOOKS_DIR" ]; then
      setup_auto_handoff
    else
      echo "Warning: Auto-handoff hook scripts not found at $HOOKS_DIR"
      echo "Make sure the auto-handoff hooks are installed. Continuing without them..."
    fi
  fi
fi

echo "Starting Ralph - Tool: $TOOL - Max iterations: $MAX_ITERATIONS"
if [[ "$AUTO_HANDOFF" == true && "$TOOL" == "claude" ]]; then
  echo "Auto-handoff: ENABLED (context will be saved before compaction)"
fi

for i in $(seq 1 $MAX_ITERATIONS); do
  echo ""
  echo "==============================================================="
  echo "  Ralph Iteration $i of $MAX_ITERATIONS ($TOOL)"
  if [[ "$AUTO_HANDOFF" == true && "$TOOL" == "claude" ]]; then
    echo "  Auto-handoff: ON"
  fi
  echo "==============================================================="

  # Run the selected tool with the ralph prompt
  if [[ "$TOOL" == "amp" ]]; then
    OUTPUT=$(cat "$SCRIPT_DIR/prompt.md" | amp --dangerously-allow-all 2>&1 | tee /dev/stderr) || true
  else
    # Claude Code: use --dangerously-skip-permissions for autonomous operation, --print for output
    OUTPUT=$(claude --dangerously-skip-permissions --print < "$SCRIPT_DIR/CLAUDE.md" 2>&1 | tee /dev/stderr) || true
  fi

  # Check for completion signal
  if echo "$OUTPUT" | grep -q "<promise>COMPLETE</promise>"; then
    echo ""
    echo "Ralph completed all tasks!"
    echo "Completed at iteration $i of $MAX_ITERATIONS"
    # Clean up handoff documents on completion
    rm -rf "$HANDOFF_DIR"/*.md 2>/dev/null || true
    exit 0
  fi

  # Clean up old handoffs between iterations
  cleanup_handoffs

  echo "Iteration $i complete. Continuing..."
  sleep 2
done

echo ""
echo "Ralph reached max iterations ($MAX_ITERATIONS) without completing all tasks."
echo "Check $PROGRESS_FILE for status."
exit 1
