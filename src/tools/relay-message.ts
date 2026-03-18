import { ToolDefinition, ToolHandler } from '../types/index.js';
import { CliSessionPool } from '../cli-session-pool.js';
import { GroupChatManagerImpl } from '../manager.js';
import { validateRelay, executeRelayAndStore, RelayInput } from './relay-common.js';

/**
 * relay_message — Workspace file reference mode (preferred).
 *
 * Sets the spawned CLI's cwd to the room directory so it can read chat.md directly.
 * The prompt is minimal (~200 tokens): just instructions to read chat.md.
 * This drastically reduces token consumption and eliminates prompt bias.
 *
 * Falls back to inline mode if file_ref is not supported by the target.
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
    },
    required: ['room_id', 'target'],
  },
};

export const toolHandler: ToolHandler = async (invocation, manager) => {
  const input = invocation.input as unknown as RelayInput;
  const { room_id, target, prompt } = input;

  // Cast manager to impl to access getFileStore()
  const mgr = manager as GroupChatManagerImpl;

  // 1. Validate
  const validation = validateRelay(input, mgr);
  if (!validation.valid) {
    return validation.result;
  }

  // 2. Verify room exists and get chat file path
  const fileStore = mgr.getFileStore();
  const chatPath = fileStore.getChatFilePath(room_id);
  const room = fileStore.getRoom(room_id);
  if (!room) {
    return {
      message: `❌ Room not found: ${room_id}`,
      data: { error: 'room_not_found' },
    };
  }

  // 3. Build minimal prompt (workspace file_ref mode)
  // The CLI process will have cwd set to the room directory,
  // so it can read ./chat.md directly.
  const parts: string[] = [
    `You are "${target}" participating in a multi-AI group chat named "${room.name}".`,
    `The other participants are AI models too.`,
    ``,
    `Your chat history is in the file "chat.md" in your current working directory.`,
    `Read it to understand the conversation context, then provide your response.`,
  ];

  if (prompt) {
    parts.push(``, `The orchestrator (Claude) asks: ${prompt}`);
  }

  parts.push(
    ``,
    `Please respond naturally and concisely as a participant in this group chat.`,
    `Do NOT repeat or summarize the conversation. Just give your own response/analysis/opinion.`,
  );

  const fullPrompt = parts.join('\n');

  // 4. Execute relay and store response (cwd = room directory for file_ref)
  const roomDir = fileStore.getRoomDir(room_id);
  return executeRelayAndStore(
    room_id,
    target,
    validation.participantId,
    fullPrompt,
    mgr,
    'file_ref',
    roomDir,
  );
};
