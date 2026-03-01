#!/usr/bin/env node
/**
 * PreCompact Hook — Save Context Before Compaction
 *
 * This hook fires immediately before Claude Code compacts the context window.
 * It's the "death boundary" — the last moment with full context access.
 *
 * It parses the transcript, extracts structured state, and saves a
 * handoff document that can be loaded by the SessionStart hook.
 *
 * Config: async: true (don't block compaction)
 * Matcher: "auto" (fires on auto-compaction, not manual /compact)
 */

import {
  readStdin,
  parseTranscript,
  extractState,
  getCurrentStory,
  formatHandoff,
  saveHandoff,
} from './utils.mjs';

async function main() {
  const input = await readStdin();

  const {
    session_id = 'unknown',
    transcript_path,
    trigger = 'auto',
  } = input;

  if (!transcript_path) {
    // No transcript available, nothing to save
    process.exit(0);
  }

  try {
    // Parse the full transcript while we still have access
    const messages = parseTranscript(transcript_path);

    if (messages.length === 0) {
      process.exit(0);
    }

    // Extract structured state from the conversation
    const state = extractState(messages);

    // Get current story info from prd.json
    const storyInfo = getCurrentStory();

    // Format as a handoff document
    const handoffContent = formatHandoff(session_id, state, storyInfo, trigger);

    // Save the handoff
    const savedPath = saveHandoff(session_id, handoffContent);

    // Log to stderr (shown in verbose mode only for PreCompact)
    process.stderr.write(`[auto-handoff] Context saved to ${savedPath}\n`);
  } catch (err) {
    // Don't block compaction on errors
    process.stderr.write(`[auto-handoff] Error saving context: ${err.message}\n`);
  }

  process.exit(0);
}

main();
