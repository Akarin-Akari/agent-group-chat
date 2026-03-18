/**
 * delete_message — Layer 2: Post-hoc cleanup tool.
 *
 * Removes a message from chat.md by sequence number.
 * The deleted message is archived to chat.deleted.log for audit trail.
 */

import { ToolDefinition, ToolHandler } from '../types/index.js';
import { GroupChatManagerImpl } from '../manager.js';

export const toolDefinition: ToolDefinition = {
  name: 'delete_message',
  description:
    'Delete a message from a room by its sequence number. ' +
    'The message is removed from chat.md and archived to chat.deleted.log for audit trail. ' +
    'Use this to clean up garbage messages (e.g., from failed relay attempts).',
  inputSchema: {
    type: 'object',
    properties: {
      room_id: {
        type: 'string',
        description: 'Room ID containing the message',
      },
      message_id: {
        type: 'string',
        description: 'Message sequence number to delete (e.g., "15")',
      },
      reason: {
        type: 'string',
        description: 'Reason for deletion (stored in audit log)',
      },
    },
    required: ['room_id', 'message_id'],
  },
};

export const toolHandler: ToolHandler = async (invocation, manager) => {
  const { room_id, message_id, reason } = invocation.input as {
    room_id: string;
    message_id: string;
    reason?: string;
  };

  const mgr = manager as GroupChatManagerImpl;

  // Validate room exists
  const room = mgr.getRoom(room_id);
  if (!room) {
    return {
      message: `❌ Room not found: ${room_id}`,
      data: { error: 'room_not_found' },
    };
  }

  // Parse sequence number
  const seq = parseInt(message_id, 10);
  if (isNaN(seq)) {
    return {
      message: `❌ Invalid message_id: "${message_id}". Must be a sequence number (e.g., "15").`,
      data: { error: 'invalid_message_id' },
    };
  }

  // Execute deletion
  try {
    const deleted = mgr.deleteMessage(room_id, seq, reason);
    if (!deleted) {
      return {
        message: `❌ Message #${seq} not found in room.`,
        data: { error: 'message_not_found', sequence: seq },
      };
    }

    return {
      message:
        `🗑️ Message #${seq} deleted from **${room.name}**.\n\n` +
        `📋 Archived to \`chat.deleted.log\` for audit trail.\n` +
        (reason ? `📝 Reason: ${reason}` : ''),
      data: {
        deleted_sequence: seq,
        room_id,
        reason: reason || null,
        archived: true,
      },
    };
  } catch (err: any) {
    return {
      message: `❌ Failed to delete message: ${err.message}`,
      data: { error: 'delete_failed', details: err.message },
    };
  }
};
