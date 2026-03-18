import { ToolDefinition, ToolHandler } from '../types/index.js';

export const toolDefinition: ToolDefinition = {
  name: 'get_context',
  description: 'Get formatted conversation context from a room, optimized for injection into AI prompts. Supports chat/summary/structured formats with automatic token-aware truncation. This is the CORE tool for multi-model context sharing.',
  inputSchema: {
    type: 'object',
    properties: {
      room_id: {
        type: 'string',
        description: 'Room ID to get context from',
      },
      max_tokens: {
        type: 'number',
        description: 'Maximum token budget for the context (default: 8000). Adjust based on target AI context window.',
      },
      format: {
        type: 'string',
        description: 'Output format: "chat" (chronological log), "summary" (condensed overview), "structured" (organized by type). Default: chat',
      },
    },
    required: ['room_id'],
  },
};

export const toolHandler: ToolHandler = async (invocation, manager) => {
  const { room_id, max_tokens, format } = invocation.input as {
    room_id: string;
    max_tokens?: number;
    format?: 'chat' | 'summary' | 'structured';
  };

  const result = manager.getContext({
    roomId: room_id,
    maxTokens: max_tokens,
    format,
  });

  return {
    message: `${result.context}\n\n---\n📊 Token estimate: ~${result.tokenEstimate} | Messages: ${result.messageCount} | Format: ${result.format} | Truncated: ${result.truncated}`,
    data: {
      token_estimate: result.tokenEstimate,
      truncated: result.truncated,
      message_count: result.messageCount,
      format: result.format,
    },
  };
};
