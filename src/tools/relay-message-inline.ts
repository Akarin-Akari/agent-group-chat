import { ToolDefinition, ToolHandler } from '../types/index.js';
import { CliSessionPool } from '../cli-session-pool.js';
import { GroupChatManagerImpl } from '../manager.js';
import { validateRelay, executeRelayAndStore, RelayInput } from './relay-common.js';

/**
 * relay_message_inline — Smart-truncated inline context mode (fallback).
 *
 * Reads the tail of chat.md and inlines it into the prompt.
 * Used when the target CLI cannot read files from cwd (e.g., pipe mode).
 * Limits context to ~4000 tokens to avoid prompt bloating.
 */

export const toolDefinition: ToolDefinition = {
  name: 'relay_message_inline',
  description:
    'Relay conversation context to another AI model with inline context (fallback mode). ' +
    'Inlines the most recent messages from chat.md (~4000 token budget) into the prompt. ' +
    'Use this if relay_message (file_ref mode) does not work for your target. ' +
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
          'Room context is automatically included inline.',
      },
      max_context_messages: {
        type: 'number',
        description: 'Maximum number of recent messages to include (default: 30)',
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
  const input = invocation.input as unknown as RelayInput & { max_context_messages?: number; cwd?: string };
  const { room_id, target, prompt, max_context_messages, cwd: userCwd } = input;

  // Cast manager to impl to access getFileStore()
  const mgr = manager as GroupChatManagerImpl;

  // 1. Validate
  const validation = validateRelay(input, mgr);
  if (!validation.valid) {
    return validation.result;
  }

  // 2. Get room context via getContext (uses formatContext with token budget)
  let contextContent: string;
  try {
    const ctx = mgr.getContext({
      roomId: room_id,
      format: 'chat',
      maxTokens: 4000,
    });
    contextContent = ctx.context;
  } catch (err: any) {
    return {
      message: `❌ Failed to get room context: ${err.message}`,
      data: { error: 'context_failed' },
    };
  }

  // 3. Determine working directory (same logic as file_ref mode)
  const effectiveCwd = userCwd || process.cwd();

  // 4. Build inline prompt with workspace context
  const parts: string[] = [
    `You are "${target}" participating in a multi-AI group chat. The other participants are AI models too.`,
    ``,
    `## Workspace`,
    `Your working directory is: ${effectiveCwd}`,
    `This is the same project workspace as the orchestrator (Claude).`,
    `You have full access to read source code, configs, docs, and any other files here.`,
    `If the discussion involves code, feel free to explore the codebase to provide informed analysis.`,
    ``,
    `## Conversation History`,
    contextContent,
    `\n---`,
  ];

  if (prompt) {
    parts.push(`\n## Task`, `The orchestrator (Claude) asks: ${prompt}`);
  }

  parts.push(
    ``,
    `## Response Guidelines`,
    `Respond naturally and concisely as a participant in this group chat.`,
    `Do NOT repeat or summarize the conversation. Just give your own response/analysis/opinion.`,
  );

  const fullPrompt = parts.join('\n');

  // 5. Execute relay and store response (cwd = project workspace)
  return executeRelayAndStore(
    room_id,
    target,
    validation.participantId,
    fullPrompt,
    mgr,
    'inline',
    effectiveCwd,
  );
};
