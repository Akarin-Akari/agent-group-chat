import { ToolDefinition, ToolHandler } from '../types/index.js';

export const toolDefinition: ToolDefinition = {
  name: 'get_messages',
  description: 'Retrieve messages from a group chat room with pagination support. Returns messages in chronological order.',
  inputSchema: {
    type: 'object',
    properties: {
      room_id: {
        type: 'string',
        description: 'Room ID to fetch messages from',
      },
      limit: {
        type: 'number',
        description: 'Max number of messages to return (default: 50)',
      },
      before: {
        type: 'number',
        description: 'Only return messages with sequence_number < this value (for backward pagination)',
      },
      after: {
        type: 'number',
        description: 'Only return messages with sequence_number > this value (for forward pagination)',
      },
    },
    required: ['room_id'],
  },
};

export const toolHandler: ToolHandler = async (invocation, manager) => {
  const { room_id, limit, before, after } = invocation.input as {
    room_id: string;
    limit?: number;
    before?: number;
    after?: number;
  };

  const result = manager.getMessages(room_id, limit, before, after);

  if (result.messages.length === 0) {
    return {
      message: 'No messages found in this room.',
      data: result,
    };
  }

  // Format messages for display
  const lines: string[] = [];
  lines.push(`📨 **${result.messages.length} messages** (has_more: ${result.hasMore})\n`);

  for (const msg of result.messages) {
    const participant = manager.getParticipant(msg.participantId);
    const name = participant?.name || msg.participantId;
    const pin = msg.isPinned ? ' 📌' : '';
    const reply = msg.replyTo ? ` ↩ reply` : '';
    lines.push(`**#${msg.sequenceNumber}** [${name}]${pin}${reply}: ${msg.content.slice(0, 200)}${msg.content.length > 200 ? '...' : ''}`);
  }

  return {
    message: lines.join('\n'),
    data: result,
  };
};
