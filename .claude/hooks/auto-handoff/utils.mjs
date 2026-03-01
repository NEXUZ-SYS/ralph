#!/usr/bin/env node
/**
 * Auto-Handoff Utilities
 *
 * Shared functions for parsing transcripts, extracting state,
 * and formatting handoff documents for context recovery.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync, symlinkSync } from 'fs';
import { join, dirname } from 'path';

/**
 * Get the project root directory.
 * Uses CLAUDE_PROJECT_DIR env var, falls back to cwd.
 */
export function getProjectRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * Get the handoff directory path, creating it if needed.
 */
export function getHandoffDir() {
  const dir = join(getProjectRoot(), 'handoff');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Parse a JSONL transcript file into an array of message objects.
 */
export function parseTranscript(transcriptPath) {
  if (!existsSync(transcriptPath)) {
    return [];
  }

  const content = readFileSync(transcriptPath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());
  const messages = [];

  for (const line of lines) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  return messages;
}

/**
 * Extract structured state from transcript messages.
 * Captures: current task, files modified, decisions, errors, progress.
 */
export function extractState(messages) {
  const state = {
    filesModified: new Set(),
    filesCreated: new Set(),
    filesRead: new Set(),
    bashCommands: [],
    errors: [],
    assistantMessages: [],
    userMessages: [],
    toolCalls: [],
    todoItems: [],
  };

  for (const msg of messages) {
    const content = msg?.message?.content;
    if (!content) continue;

    const role = msg?.message?.role;

    if (role === 'assistant') {
      if (typeof content === 'string') {
        state.assistantMessages.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            state.assistantMessages.push(block.text);
          }
          if (block.type === 'tool_use') {
            state.toolCalls.push({
              tool: block.name,
              input: block.input,
            });
            extractToolInfo(block, state);
          }
        }
      }
    }

    if (role === 'user') {
      if (typeof content === 'string') {
        state.userMessages.push(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          // Check for tool results with errors
          if (block.type === 'tool_result' && block.is_error) {
            const errorText = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
            state.errors.push(errorText.slice(0, 500));
          }
        }
      }
    }
  }

  return {
    filesModified: [...state.filesModified],
    filesCreated: [...state.filesCreated],
    filesRead: [...state.filesRead],
    bashCommands: state.bashCommands.slice(-20), // Last 20 commands
    errors: state.errors.slice(-10), // Last 10 errors
    assistantSummary: getLastAssistantSummary(state.assistantMessages),
    todoItems: state.todoItems,
    totalToolCalls: state.toolCalls.length,
  };
}

/**
 * Extract file and command info from a tool call block.
 */
function extractToolInfo(block, state) {
  const { name, input } = block;
  if (!input) return;

  switch (name) {
    case 'Write':
      if (input.file_path) state.filesCreated.add(input.file_path);
      break;
    case 'Edit':
      if (input.file_path) state.filesModified.add(input.file_path);
      break;
    case 'Read':
      if (input.file_path) state.filesRead.add(input.file_path);
      break;
    case 'Bash':
      if (input.command) {
        state.bashCommands.push(input.command.slice(0, 200));
      }
      break;
    case 'TodoWrite':
      if (input.todos) {
        state.todoItems = input.todos;
      }
      break;
  }
}

/**
 * Get a summary from the last few assistant messages.
 */
function getLastAssistantSummary(messages) {
  // Take the last 3 text messages, truncated
  return messages
    .filter(m => m.length > 20) // Skip very short messages
    .slice(-3)
    .map(m => m.slice(0, 500))
    .join('\n\n---\n\n');
}

/**
 * Try to read prd.json to get current story info.
 */
export function getCurrentStory() {
  const prdPath = join(getProjectRoot(), 'prd.json');
  if (!existsSync(prdPath)) return null;

  try {
    const prd = JSON.parse(readFileSync(prdPath, 'utf-8'));
    const currentStory = prd.userStories
      ?.filter(s => !s.passes)
      ?.sort((a, b) => (a.priority || 999) - (b.priority || 999))?.[0];

    return {
      project: prd.project,
      branch: prd.branchName,
      story: currentStory || null,
      totalStories: prd.userStories?.length || 0,
      completedStories: prd.userStories?.filter(s => s.passes)?.length || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Try to read recent entries from progress.txt.
 */
export function getRecentProgress() {
  const progressPath = join(getProjectRoot(), 'progress.txt');
  if (!existsSync(progressPath)) return '';

  try {
    const content = readFileSync(progressPath, 'utf-8');
    // Get the Codebase Patterns section and the last entry
    const sections = content.split('---');
    const patterns = sections.find(s => s.includes('Codebase Patterns')) || '';
    const lastEntry = sections.filter(s => s.trim()).slice(-1)[0] || '';
    return [patterns.trim(), lastEntry.trim()].filter(Boolean).join('\n\n---\n\n');
  } catch {
    return '';
  }
}

/**
 * Format the extracted state into a markdown handoff document.
 */
export function formatHandoff(sessionId, state, storyInfo, trigger) {
  const timestamp = new Date().toISOString();
  const lines = [];

  lines.push(`# Session Handoff`);
  lines.push(`- **Session:** ${sessionId}`);
  lines.push(`- **Timestamp:** ${timestamp}`);
  lines.push(`- **Trigger:** ${trigger || 'auto-compact'}`);
  lines.push('');

  // Current task info
  if (storyInfo?.story) {
    lines.push('## Current Task');
    lines.push(`- **Story:** ${storyInfo.story.id} - ${storyInfo.story.title}`);
    lines.push(`- **Description:** ${storyInfo.story.description}`);
    lines.push(`- **Branch:** ${storyInfo.branch}`);
    lines.push(`- **Progress:** ${storyInfo.completedStories}/${storyInfo.totalStories} stories complete`);
    lines.push('');
    if (storyInfo.story.acceptanceCriteria?.length) {
      lines.push('### Acceptance Criteria');
      for (const ac of storyInfo.story.acceptanceCriteria) {
        lines.push(`- [ ] ${ac}`);
      }
      lines.push('');
    }
  }

  // TODO items
  if (state.todoItems?.length) {
    lines.push('## Current TODO List');
    for (const todo of state.todoItems) {
      const icon = todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '>' : ' ';
      lines.push(`- [${icon}] ${todo.content} (${todo.status})`);
    }
    lines.push('');
  }

  // Files modified
  if (state.filesCreated.length || state.filesModified.length) {
    lines.push('## Files Changed');
    if (state.filesCreated.length) {
      lines.push('### Created');
      for (const f of state.filesCreated) {
        lines.push(`- ${f}`);
      }
    }
    if (state.filesModified.length) {
      lines.push('### Modified');
      for (const f of state.filesModified) {
        lines.push(`- ${f}`);
      }
    }
    lines.push('');
  }

  // Recent commands
  if (state.bashCommands.length) {
    lines.push('## Recent Commands');
    lines.push('```bash');
    for (const cmd of state.bashCommands.slice(-10)) {
      lines.push(`$ ${cmd}`);
    }
    lines.push('```');
    lines.push('');
  }

  // Errors
  if (state.errors.length) {
    lines.push('## Errors Encountered');
    for (const err of state.errors) {
      lines.push(`- ${err.replace(/\n/g, ' ').slice(0, 200)}`);
    }
    lines.push('');
  }

  // Assistant summary (what was being worked on)
  if (state.assistantSummary) {
    lines.push('## Last Progress Notes');
    lines.push(state.assistantSummary);
    lines.push('');
  }

  // Progress context
  const progress = getRecentProgress();
  if (progress) {
    lines.push('## Context from progress.txt');
    lines.push(progress);
    lines.push('');
  }

  // Stats
  lines.push('## Session Stats');
  lines.push(`- Total tool calls: ${state.totalToolCalls}`);
  lines.push(`- Files read: ${state.filesRead.length}`);
  lines.push(`- Files created: ${state.filesCreated.length}`);
  lines.push(`- Files modified: ${state.filesModified.length}`);
  lines.push(`- Commands run: ${state.bashCommands.length}`);
  lines.push(`- Errors encountered: ${state.errors.length}`);

  return lines.join('\n');
}

/**
 * Save a handoff document and update the latest symlink.
 */
export function saveHandoff(sessionId, content) {
  const dir = getHandoffDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `handoff-${sessionId.slice(0, 8)}-${timestamp}.md`;
  const filepath = join(dir, filename);

  writeFileSync(filepath, content, 'utf-8');

  // Update latest.md (write directly instead of symlink for portability)
  const latestPath = join(dir, 'latest.md');
  writeFileSync(latestPath, content, 'utf-8');

  // Cleanup old handoffs (keep last 5)
  cleanupOldHandoffs(dir, 5);

  return filepath;
}

/**
 * Load the latest handoff document.
 */
export function loadLatestHandoff() {
  const latestPath = join(getHandoffDir(), 'latest.md');
  if (!existsSync(latestPath)) return null;

  try {
    return readFileSync(latestPath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Remove old handoff files, keeping the N most recent.
 */
function cleanupOldHandoffs(dir, keep) {
  try {
    const files = readdirSync(dir)
      .filter(f => f.startsWith('handoff-') && f.endsWith('.md'))
      .sort()
      .reverse();

    for (const file of files.slice(keep)) {
      unlinkSync(join(dir, file));
    }
  } catch {
    // Non-critical, ignore errors
  }
}

/**
 * Read JSON from stdin (used by all hooks).
 */
export function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    // Handle case where stdin is already closed
    if (process.stdin.readableEnded) {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    }
  });
}
