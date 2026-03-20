import { ToolDefinition, ToolHandler } from '../types/index.js';
import { CliSessionPool } from '../cli-session-pool.js';
import { GroupChatManagerImpl } from '../manager.js';
import { validateRelay, executeRelayAndStore, RelayInput } from './relay-common.js';

/**
 * relay_message — Workspace file reference mode (preferred).
 *
 * Spawns the CLI with cwd set to the project working directory (same as the
 * orchestrator) so the target AI shares the same codebase context.  The prompt
 * tells it the absolute path to chat.md for conversation history.
 *
 * This gives the target AI two superpowers:
 *   1. It can read chat.md to understand the group discussion.
 *   2. It can freely explore the project source code in its working directory.
 */

export const toolDefinition: ToolDefinition = {
  name: 'relay_message',
  description:
    'Relay conversation context to another AI model (Codex or Gemini) via their CLI. ' +
    'Uses workspace file reference mode: the target AI reads chat.md directly from its working directory. ' +
    'This minimizes token consumption (~200 token prompt vs ~4000 inline). ' +
    'The response is automatically stored as a message in the room.',
  inputSchema: {
    type: 'object',
    properties: {
      room_id: {
        type: 'string',
        description: 'Room ID to relay from/to',
      },
      target: {
        type: 'string',
        enum: CliSessionPool.getSupportedTargets(),
        description: 'Target AI model: "codex" (GPT-5.2) or "gemini" (Gemini 2.5 Pro)',
      },
      prompt: {
        type: 'string',
        description:
          'Optional additional instruction or question for the target AI. ' +
          'Room context is provided via chat.md file reference.',
      },
      cwd: {
        type: 'string',
        description:
          'Working directory for the target CLI (default: project root). ' +
          'Set this to the project directory so the target AI can explore source code.',
      },
    },
    required: ['room_id', 'target'],
  },
};

export const toolHandler: ToolHandler = async (invocation, manager) => {
  const input = invocation.input as unknown as RelayInput & { cwd?: string };
  const { room_id, target, prompt, cwd: userCwd } = input;

  // Cast manager to impl to access getFileStore()
  const mgr = manager as GroupChatManagerImpl;

  // 1. Validate
  const validation = validateRelay(input, mgr);
  if (!validation.valid) {
    return validation.result;
  }

  // 2. Verify room exists and get chat file path (absolute)
  const fileStore = mgr.getFileStore();
  const chatPath = fileStore.getChatFilePath(room_id);
  const room = fileStore.getRoom(room_id);
  if (!room) {
    return {
      message: `❌ Room not found: ${room_id}`,
      data: { error: 'room_not_found' },
    };
  }

  // 3. Determine working directory:
  //    Priority: user-specified cwd > project root (process.cwd()) > room dir (fallback)
  //    Goal: target AI shares the same workspace as the orchestrator.
  const effectiveCwd = userCwd || process.cwd();

  // 4. Build prompt with absolute paths + workspace exploration encouragement
  // P0: Explicit no-write directive. P3: Do NOT expose room directory path.
  const parts: string[] = [
    `## Identity`,
    `You are "${target}" participating in a multi-AI group chat named "${room.name}".`,
    `The other participants are AI models too.`,
    ``,
    `## Conversation`,
    `Chat history file (READ-ONLY): ${chatPath}`,
    `Read this file first to understand what has been discussed.`,
    ``,
    `## Workspace`,
    `Working directory: ${effectiveCwd}`,
    `This is the same project workspace as the orchestrator (Claude).`,
    `You have full access to read source code, configs, docs, and any other files in the workspace.`,
    `If the discussion involves code, feel free to explore the codebase to provide informed analysis.`,
    ``,
    `## CRITICAL RULES`,
    `- Your response MUST be written to stdout ONLY.`,
    `- DO NOT write, modify, overwrite, summarize-into, or delete the chat history file or any file near it.`,
    `- DO NOT create any new files to store your response. Just output to stdout.`,
    `- The chat history file is strictly READ-ONLY. Modifying it will corrupt the shared conversation.`,
  ];

  if (prompt) {
    parts.push(``, `## Task`, `The orchestrator (Claude) asks: ${prompt}`);
  }

  parts.push(
    ``,
    `## Response Guidelines`,
    `Respond naturally and concisely as a participant in this group chat.`,
    `Do NOT repeat or summarize the conversation. Just give your own response/analysis/opinion.`,
  );

  const fullPrompt = parts.join('\n');

  // 5. Execute relay and store response
  return executeRelayAndStore(
    room_id,
    target,
    validation.participantId,
    fullPrompt,
    mgr,
    'file_ref',
    effectiveCwd,
  );
};
