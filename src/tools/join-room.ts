import { ToolDefinition, ToolHandler } from '../types/index.js';

export const toolDefinition: ToolDefinition = {
  name: 'join_room',
  description: 'Add a registered participant to a chat room. The participant will then be able to send/receive messages in this room.',
  inputSchema: {
    type: 'object',
    properties: {
      room_id: {
        type: 'string',
        description: 'The room ID to join',
      },
      participant_id: {
        type: 'string',
        description: 'The participant ID to add to the room',
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

  manager.joinRoom(room_id, participant_id);

  const room = manager.getRoom(room_id);
  const participant = manager.getParticipant(participant_id);
  const members = manager.getRoomParticipants(room_id);

  return {
    message: `✅ **${participant?.name || participant_id}** joined room **${room?.name || room_id}**\n👥 Current members: ${members.map(m => m.name).join(', ')}`,
  };
};
