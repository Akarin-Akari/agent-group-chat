import { ToolDefinition, ToolHandler } from '../types/index.js';

export const toolDefinition: ToolDefinition = {
  name: 'import_from_thread',
  description: 'Import messages from a thread-manager thread into a group chat room. Creates the room if it does not exist.',
  inputSchema: {
    type: 'object',
    properties: {
      thread_id: {
        type: 'string',
        description: 'Thread ID from thread-manager to import from',
      },
      room_id: {
        type: 'string',
        description: 'Target room ID to import into',
      },
    },
    required: ['thread_id', 'room_id'],
  },
};

export const toolHandler: ToolHandler = async (invocation, manager) => {
  const { thread_id, room_id } = invocation.input as {
    thread_id: string;
    room_id: string;
  };

  const importedCount = manager.importFromThread(thread_id, room_id);

  if (importedCount === 0) {
    return {
      message: `⚠️ No messages imported. The thread-manager bridge is not yet fully implemented.`,
      data: { imported_count: 0, thread_id, room_id },
    };
  }

  return {
    message: `📥 Imported ${importedCount} message(s) from thread \`${thread_id}\` into room \`${room_id}\`.`,
    data: { imported_count: importedCount, thread_id, room_id },
  };
};
