import { ToolDefinition, ToolHandler } from '../types/index.js';
import { GroupChatManagerImpl } from '../manager.js';

export const toolDefinition: ToolDefinition = {
  name: 'create_room',
  description: 'Create a new group chat room for multi-model collaboration. Returns the room ID for subsequent operations.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Room name (e.g. "Architecture Discussion", "Bug Triage #42")',
      },
      description: {
        type: 'string',
        description: 'Optional room description / purpose',
      },
      max_context_messages: {
        type: 'number',
        description: 'Maximum messages to include in context (default: 200)',
      },
      moderation_level: {
        type: 'string',
        description: 'Relay response moderation: "none" (no checks), "normal" (heuristic gate, default), "strict" (gate + manual approval for suspect responses)',
      },
    },
    required: ['name'],
  },
};

export const toolHandler: ToolHandler = async (invocation, manager) => {
  const { name, description, max_context_messages, moderation_level } = invocation.input as {
    name: string;
    description?: string;
    max_context_messages?: number;
    moderation_level?: 'none' | 'normal' | 'strict';
  };

  const mgr = manager as GroupChatManagerImpl;
  const room = mgr.createRoomWithModeration(name, description, max_context_messages, moderation_level);
  const level = moderation_level || 'normal';

  return {
    message:
      `Room created successfully.\n\n` +
      `🏠 **${room.name}**\n` +
      `📝 ID: \`${room.id}\`\n` +
      `📄 Description: ${room.description || '(none)'}\n` +
      `📊 Max context messages: ${room.maxContextMessages}\n` +
      `🛡️ Moderation: ${level}`,
    data: { ...room, moderationLevel: level },
  };
};
