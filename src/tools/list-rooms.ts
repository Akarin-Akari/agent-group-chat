import { ToolDefinition, ToolHandler } from '../types/index.js';

export const toolDefinition: ToolDefinition = {
  name: 'list_rooms',
  description: 'List all group chat rooms. Optionally filter to only active (non-archived) rooms.',
  inputSchema: {
    type: 'object',
    properties: {
      active_only: {
        type: 'boolean',
        description: 'If true, only show non-archived rooms (default: false)',
      },
    },
  },
};

export const toolHandler: ToolHandler = async (invocation, manager) => {
  const { active_only } = invocation.input as { active_only?: boolean };

  const rooms = manager.listRooms(active_only);

  if (rooms.length === 0) {
    return {
      message: '📭 No rooms found. Use `create_room` to create one.',
      data: { rooms: [], count: 0 },
    };
  }

  const lines: string[] = [];
  lines.push(`🏠 **${rooms.length} room(s)**\n`);

  for (const room of rooms) {
    const archived = room.isArchived ? ' 🗄️' : '';
    const updated = new Date(room.updatedAt).toISOString().slice(0, 19).replace('T', ' ');
    lines.push(`- **${room.name}**${archived} — \`${room.id}\``);
    lines.push(`  ${room.description || '(no description)'} | Last activity: ${updated}`);
  }

  return {
    message: lines.join('\n'),
    data: { rooms, count: rooms.length },
  };
};
