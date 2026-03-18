import { ToolDefinition, ToolHandler } from '../types/index.js';

export const toolDefinition: ToolDefinition = {
  name: 'pin_message',
  description: 'Pin an important message in a room by its sequence number. Pinned messages are always included in context output regardless of truncation.',
  inputSchema: {
    type: 'object',
    properties: {
      room_id: {
        type: 'string',
        description: 'Room ID containing the message',
      },
      message_id: {
        type: 'string',
        description: 'Message sequence number to pin (e.g., "3" for message #3)',
      },
    },
    required: ['room_id', 'message_id'],
  },
};

export const toolHandler: ToolHandler = async (invocation, manager) => {
  const { room_id, message_id } = invocation.input as {
    room_id: string;
    message_id: string;
  };

  manager.pinMessage(room_id, message_id);

  return {
    message: `📌 Message \`${message_id}\` has been pinned.`,
  };
};
