import { ToolDefinition, ToolHandler } from '../types/index.js';

export const toolDefinition: ToolDefinition = {
  name: 'poll_new_messages',
  description: 'Get new (unread) messages for a specific participant since their last read position. Automatically advances the read cursor.',
  inputSchema: {
    type: 'object',
    properties: {
      room_id: {
        type: 'string',
        description: 'Room ID to poll from',
      },
      participant_id: {
        type: 'string',
        description: 'Participant ID whose cursor to use',
      },
    },
    required: ['room_id', 'participant_id'],
  },
};

export const toolHandler: ToolHandler = async (invocation, manager) => {
  const { room_id, participant_id } = invocation.input as {
    room_id: string;
    participant_id: string;
  };

  const result = manager.pollNewMessages(room_id, participant_id);

  if (result.count === 0) {
    return {
      message: '📭 No new messages.',
      data: result,
    };
  }

  const lines: string[] = [];
  lines.push(`📬 **${result.count} new message(s)**\n`);

  for (const msg of result.messages) {
    const participant = manager.getParticipant(msg.participantId);
    const name = participant?.name || msg.participantId;
    const pin = msg.isPinned ? ' 📌' : '';
    lines.push(`**#${msg.sequenceNumber}** [${name}]${pin}: ${msg.content.slice(0, 300)}${msg.content.length > 300 ? '...' : ''}`);
  }

  return {
    message: lines.join('\n'),
    data: result,
  };
};
