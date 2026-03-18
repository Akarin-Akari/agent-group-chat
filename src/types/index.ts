// ─── Core Domain Types ───

export interface Room {
  id: string;
  name: string;
  description: string | null;
  maxContextMessages: number;
  createdAt: number;
  updatedAt: number;
  isArchived: boolean;
}

export interface Participant {
  id: string;
  name: string;
  model: string | null;
  role: ParticipantRole;
  createdAt: number;
}

export type ParticipantRole = 'orchestrator' | 'expert' | 'reviewer' | 'observer';

export interface RoomParticipant {
  roomId: string;
  participantId: string;
  joinedAt: number;
  lastReadSequence: number;
}

export interface Message {
  id: string;
  roomId: string;
  participantId: string;
  sequenceNumber: number;
  content: string;
  messageType: MessageType;
  replyTo: string | null;
  metadata: Record<string, unknown> | null;
  isPinned: boolean;
  createdAt: number;
}

export type MessageType = 'text' | 'code' | 'decision' | 'action' | 'summary';

/** Room moderation level for relay response validation */
export type ModerationLevel = 'none' | 'normal' | 'strict';

// ─── Tool Infrastructure Types ───

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolInvocation {
  toolName: string;
  input: Record<string, unknown>;
}

export type ToolHandler = (invocation: ToolInvocation, manager: GroupChatManager) => Promise<ToolResult>;

export interface ToolResult {
  message?: string;
  data?: unknown;
  error?: string;
}

// ─── Context Formatting Types ───

export type ContextFormat = 'chat' | 'summary' | 'structured';

export interface ContextOptions {
  roomId: string;
  maxTokens?: number;
  format?: ContextFormat;
  includeParticipantInfo?: boolean;
}

export interface ContextResult {
  context: string;
  tokenEstimate: number;
  truncated: boolean;
  messageCount: number;
  format: ContextFormat;
}

// ─── Manager Interface ───

export interface GroupChatManager {
  // Room operations
  createRoom(name: string, description?: string, maxContextMessages?: number): Room;
  listRooms(activeOnly?: boolean): Room[];
  getRoom(roomId: string): Room | null;

  // Participant operations
  registerParticipant(name: string, model?: string, role?: ParticipantRole): Participant;
  getParticipant(participantId: string): Participant | null;
  getParticipantByName(name: string): Participant | null;

  // Room membership
  joinRoom(roomId: string, participantId: string): void;
  getRoomParticipants(roomId: string): Participant[];

  // Messaging
  sendMessage(
    roomId: string,
    participantId: string,
    content: string,
    messageType?: MessageType,
    replyTo?: string
  ): Message;
  getMessages(roomId: string, limit?: number, before?: number, after?: number): { messages: Message[]; hasMore: boolean };
  pollNewMessages(roomId: string, participantId: string): { messages: Message[]; count: number };
  pinMessage(roomId: string, messageId: string): void;
  deleteMessage(roomId: string, seq: number, reason?: string): boolean;
  searchMessages(roomId: string, query: string, limit?: number): Message[];

  // Context
  getContext(options: ContextOptions): ContextResult;

  // Export / Import
  exportRoom(roomId: string, format: 'markdown' | 'json'): string;
  importFromThread(threadId: string, roomId: string): number;
}
