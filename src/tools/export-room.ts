import { ToolDefinition, ToolHandler } from '../types/index.js';

export const toolDefinition: ToolDefinition = {
  name: 'export_room',
  description: 'Export all messages in a room as Markdown or JSON. Useful for archiving, sharing, or feeding into other tools.',
  inputSchema: {
    type: 'object',
    properties: {
      room_id: {
        type: 'string',
        description: 'Room ID to export',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'json'],
        description: 'Export format: "markdown" or "json" (default: markdown)',
      },
    },
    required: ['room_id'],
  },
};

export const toolHandler: ToolHandler = async (invocation, manager) => {
  const { room_id, format } = invocation.input as {
    room_id: string;
    format?: 'markdown' | 'json';
  };

  const exportFormat = format || 'markdown';
  const content = manager.exportRoom(room_id, exportFormat);

  return {
    message: `📄 Room exported as ${exportFormat} (${content.length} characters).`,
    data: { content, format: exportFormat },
  };
};
