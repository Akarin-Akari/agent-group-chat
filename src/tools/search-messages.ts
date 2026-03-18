import { ToolDefinition, ToolHandler } from '../types/index.js';

export const toolDefinition: ToolDefinition = {
  name: 'search_messages',
  description: 'Search messages in a room by keyword. Returns matching messages sorted by relevance.',
  inputSchema: {
    type: 'object',
    properties: {
      room_id: {
        type: 'string',
        description: 'Room ID to search in',
      },
      query: {
        type: 'string',
        description: 'Search query (keyword match)',
      },
      limit: {
        type: 'number',
        description: 'Max results to return (default: 20)',
      },
    },
    required: ['room_id', 'query'],
  },
};

export const toolHandler: ToolHandler = async (invocation, manager) => {
  const { room_id, query, limit } = invocation.input as {
    room_id: string;
    query: string;
    limit?: number;
  };

  const results = manager.searchMessages(room_id, query, limit);

  if (results.length === 0) {
    return {
      message: `🔍 No messages matching "${query}" found.`,
      data: { results: [], count: 0 },
    };
  }

  const lines: string[] = [];
  lines.push(`🔍 **${results.length} result(s)** for "${query}"\n`);

  for (const msg of results) {
    const participant = manager.getParticipant(msg.participantId);
    const name = participant?.name || msg.participantId;
    lines.push(`**#${msg.sequenceNumber}** [${name}]: ${msg.content.slice(0, 200)}${msg.content.length > 200 ? '...' : ''}`);
  }

  return {
    message: lines.join('\n'),
    data: { results, count: results.length },
  };
};
