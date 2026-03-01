#!/usr/bin/env node
/**
 * Stop Hook — Verify Handoff on Stop
 *
 * This hook fires when Claude finishes responding. It checks:
 * 1. Whether the current story is complete
 * 2. Whether there are more stories to work on
 * 3. Whether a handoff should be saved for the next iteration
 *
 * In Ralph mode (when prd.json exists), this ensures proper
 * state is saved between iterations even when Claude stops
 * normally (not due to compaction).
 *
 * IMPORTANT: Checks stop_hook_active to prevent infinite loops.
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
    stop_hook_active = false,
    last_assistant_message = '',
  } = input;

  // Prevent infinite loops — if we're already in a stop hook cycle, let it stop
  if (stop_hook_active) {
    process.exit(0);
  }

  try {
    const storyInfo = getCurrentStory();

    // No prd.json = not in Ralph mode, just save a handoff and let it stop
    if (!storyInfo) {
      if (transcript_path) {
        saveQuickHandoff(session_id, transcript_path);
      }
      process.exit(0);
    }

    // Check if the completion signal is present
    if (last_assistant_message.includes('<promise>COMPLETE</promise>')) {
      // All stories done, save final handoff and stop
      if (transcript_path) {
        saveQuickHandoff(session_id, transcript_path);
      }
      process.exit(0);
    }

    // Check if current story was just marked as complete
    if (!storyInfo.story) {
      // All stories are complete
      process.exit(0);
    }

    // Story still pending — save handoff for the next Ralph iteration
    if (transcript_path) {
      const messages = parseTranscript(transcript_path);
      const state = extractState(messages);
      const handoffContent = formatHandoff(session_id, state, storyInfo, 'stop');
      saveHandoff(session_id, handoffContent);
      process.stderr.write(`[auto-handoff] Handoff saved on stop for next iteration\n`);
    }

    // Let Claude stop normally — Ralph's bash loop will spawn a new instance
    process.exit(0);
  } catch (err) {
    process.stderr.write(`[auto-handoff] Error in stop hook: ${err.message}\n`);
    process.exit(0);
  }
}

/**
 * Save a quick handoff without full state extraction.
 * Used when we just need a lightweight checkpoint.
 */
function saveQuickHandoff(sessionId, transcriptPath) {
  try {
    const messages = parseTranscript(transcriptPath);
    if (messages.length === 0) return;

    const state = extractState(messages);
    const storyInfo = getCurrentStory();
    const handoffContent = formatHandoff(sessionId, state, storyInfo, 'stop');
    saveHandoff(sessionId, handoffContent);
  } catch {
    // Non-critical
  }
}

main();
