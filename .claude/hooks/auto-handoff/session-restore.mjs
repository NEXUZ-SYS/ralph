#!/usr/bin/env node
/**
 * SessionStart Hook — Restore Context After Compaction
 *
 * This hook fires when a session starts after compaction.
 * It loads the most recent handoff document and injects it
 * as additional context so Claude has full awareness of:
 * - What was being worked on
 * - What files were changed
 * - What decisions were made
 * - What errors occurred and how they were handled
 *
 * Matcher: "compact" (only fires after compaction, not on fresh starts)
 */

import {
  readStdin,
  loadLatestHandoff,
  getCurrentStory,
} from './utils.mjs';

async function main() {
  await readStdin();

  // Matcher "compact" in settings.json ensures this hook only fires after compaction.
  try {
    const handoff = loadLatestHandoff();

    if (!handoff) {
      // No handoff document available, provide minimal context
      const storyInfo = getCurrentStory();
      if (storyInfo?.story) {
        const context = [
          '## Context Recovery (No Handoff Found)',
          '',
          'The context was just compacted. No handoff document was found.',
          `You are working on: ${storyInfo.story.id} - ${storyInfo.story.title}`,
          `Branch: ${storyInfo.branch}`,
          `Progress: ${storyInfo.completedStories}/${storyInfo.totalStories} stories complete`,
          '',
          'Please review prd.json and progress.txt to re-establish context.',
        ].join('\n');

        const output = JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: context,
          },
        });
        process.stdout.write(output);
      }
      process.exit(0);
    }

    // Inject the full handoff document as additional context
    const preamble = [
      '## AUTO-HANDOFF: Context Recovery After Compaction',
      '',
      'The context window was compacted. Below is your saved state from before compaction.',
      'Use this to continue exactly where you left off without losing any progress.',
      '',
      '---',
      '',
    ].join('\n');

    const output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: preamble + handoff,
      },
    });

    process.stdout.write(output);
    process.stderr.write('[auto-handoff] Context restored from handoff document\n');
  } catch (err) {
    process.stderr.write(`[auto-handoff] Error restoring context: ${err.message}\n`);
  }

  process.exit(0);
}

main();
