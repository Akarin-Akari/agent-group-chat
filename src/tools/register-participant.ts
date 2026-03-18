import { ToolDefinition, ToolHandler } from '../types/index.js';

export const toolDefinition: ToolDefinition = {
  name: 'register_participant',
  description: 'Register an AI participant identity (Claude, Codex, Gemini, etc.). If a participant with the same name already exists, returns the existing one.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Participant name (e.g. "claude", "codex", "gemini")',
      },
      model: {
        type: 'string',
        description: 'Model identifier (e.g. "claude-opus-4-6", "gpt-5.2", "gemini-2.5-pro")',
      },
      role: {
        type: 'string',
        description: 'Role: orchestrator | expert | reviewer | observer (default: expert)',
      },
    },
    required: ['name'],
  },
};

export const toolHandler: ToolHandler = async (invocation, manager) => {
  const { name, model, role } = invocation.input as {
    name: string;
    model?: string;
    role?: 'orchestrator' | 'expert' | 'reviewer' | 'observer';
  };

  const participant = manager.registerParticipant(name, model, role);

  return {
    message: `Participant registered.\n\n👤 **${participant.name}**\n🆔 ID: \`${participant.id}\`\n🤖 Model: ${participant.model || '(not specified)'}\n🎭 Role: ${participant.role}`,
    data: participant,
  };
};
