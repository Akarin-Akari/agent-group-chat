import { ToolDefinition, ToolHandler } from '../types/index.js';

export const toolDefinition: ToolDefinition = {
  name: 'send_message',
  description: 'Send a message to a group chat room on behalf of a participant. Returns the message ID and sequence number.',
  inputSchema: {
    type: 'object',
    properties: {
      room_id: {
        type: 'string',
        description: 'Target room ID',
      },
      participant_id: {
        type: 'string',
        description: 'Sender participant ID',
      },
      content: {
        type: 'string',
        description: 'Message content',
      },
      message_type: {
        type: 'string',
        description: 'Message type: text | code | decision | action | summary (default: text)',
      },
      reply_to: {
        type: 'string',
        description: 'Optional message ID this is replying to',
      },
    },
    required: ['room_id', 'participant_id', 'content'],
  },
};

export const toolHandler: ToolHandler = async (invocation, manager) => {
  const { room_id, participant_id, content, message_type, reply_to } = invocation.input as {
    room_id: string;
    participant_id: string;
    content: string;
    message_type?: 'text' | 'code' | 'decision' | 'action' | 'summary';
    reply_to?: string;
  };

  const msg = manager.sendMessage(room_id, participant_id, content, message_type, reply_to);

  const participant = manager.getParticipant(participant_id);

  return {
    message: `Message sent.\n\n💬 From: **${participant?.name || participant_id}**\n🆔 Message ID: \`${msg.id}\`\n📊 Sequence: #${msg.sequenceNumber}\n📝 Type: ${msg.messageType}`,
    data: { message_id: msg.id, sequence_number: msg.sequenceNumber },
  };
};
