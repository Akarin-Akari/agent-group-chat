import { v4 as uuidv4 } from 'uuid';
import { FileStore, ParticipantRecord } from './storage/file-store.js';
import { formatContext } from './context/formatter.js';
import {
  Room, Participant, ParticipantRole, Message, MessageType,
  ContextOptions, ContextResult, GroupChatManager as IGroupChatManager,
} from './types/index.js';

/**
 * GroupChatManager — "MD 文档即群聊" 版本
 *
 * 所有数据的 ground truth 是 MD 文件和 JSON 文件。
 * SQLite 已被移除，FileStore 作为唯一数据源。
 */
export class GroupChatManagerImpl implements IGroupChatManager {
  private fileStore: FileStore;

  /**
   * Room participants' last-read sequence tracking.
   * Key: `${roomId}:${participantId}`, Value: last read sequence number.
   * In-memory only — resets on server restart (acceptable for MCP server).
   */
  private lastReadSequences: Map<string, number> = new Map();

  constructor(fileStore: FileStore) {
    this.fileStore = fileStore;
  }

  // ─── Room Operations ───

  createRoom(name: string, description?: string, maxContextMessages?: number): Room {
    return this.fileStore.createRoom(name, description, maxContextMessages);
  }

  createRoomWithModeration(name: string, description?: string, maxContextMessages?: number, moderationLevel?: 'none' | 'normal' | 'strict'): Room {
    return this.fileStore.createRoom(name, description, maxContextMessages, moderationLevel);
  }

  listRooms(activeOnly: boolean = false): Room[] {
    return this.fileStore.listRooms(activeOnly);
  }

  getRoom(roomId: string): Room | null {
    return this.fileStore.getRoom(roomId);
  }

  // ─── Participant Operations ───

  registerParticipant(name: string, model?: string, role?: ParticipantRole): Participant {
    // If participant already exists with this name, return existing
    const existing = this.fileStore.getParticipantByName(name);
    if (existing) {
      return this.fileStore.participantRecordToParticipant(existing);
    }

    const record: ParticipantRecord = {
      id: uuidv4(),
      name,
      model: model || null,
      role: role || 'expert',
      createdAt: new Date().toISOString(),
    };
    this.fileStore.saveParticipant(record);

    console.error(`[group-chat] Registered participant: ${name} (${record.id})`);
    return this.fileStore.participantRecordToParticipant(record);
  }

  getParticipant(participantId: string): Participant | null {
    const record = this.fileStore.getParticipantById(participantId);
    return record ? this.fileStore.participantRecordToParticipant(record) : null;
  }

  getParticipantByName(name: string): Participant | null {
    const record = this.fileStore.getParticipantByName(name);
    return record ? this.fileStore.participantRecordToParticipant(record) : null;
  }

  // ─── Room Membership ───

  joinRoom(roomId: string, participantId: string): void {
    const room = this.fileStore.getRoom(roomId);
    if (!room) throw new Error(`Room not found: ${roomId}`);

    const participant = this.fileStore.getParticipantById(participantId);
    if (!participant) throw new Error(`Participant not found: ${participantId}`);

    this.fileStore.addRoomParticipant(roomId, participant.name);
  }

  getRoomParticipants(roomId: string): Participant[] {
    const records = this.fileStore.getRoomParticipants(roomId);
    return records.map(r => this.fileStore.participantRecordToParticipant(r));
  }

  // ─── Messaging ───

  sendMessage(
    roomId: string,
    participantId: string,
    content: string,
    messageType: MessageType = 'text',
    replyTo?: string,
  ): Message {
    const room = this.fileStore.getRoom(roomId);
    if (!room) throw new Error(`Room not found: ${roomId}`);

    // Resolve participant name from ID
    const participant = this.fileStore.getParticipantById(participantId);
    if (!participant) throw new Error(`Participant not found: ${participantId}`);

    // Ensure participant is in the room
    this.fileStore.addRoomParticipant(roomId, participant.name);

    const msg = this.fileStore.appendMessage(roomId, participant.name, content, {
      messageType,
      replyTo,
    });

    // Fix participantId to be the actual UUID, not the name
    msg.participantId = participantId;

    // Update room timestamp
    this.fileStore.updateRoomTimestamp(roomId);

    return msg;
  }

  getMessages(
    roomId: string,
    limit?: number,
    before?: number,
    after?: number,
  ): { messages: Message[]; hasMore: boolean } {
    const result = this.fileStore.readMessages(roomId, { limit, before, after });
    const participantMap = this.buildParticipantMap();

    return {
      messages: result.messages.map(m => this.parsedToMessage(roomId, m, participantMap)),
      hasMore: result.hasMore,
    };
  }

  pollNewMessages(roomId: string, participantId: string): { messages: Message[]; count: number } {
    const key = `${roomId}:${participantId}`;
    const lastRead = this.lastReadSequences.get(key) || 0;

    const newMsgs = this.fileStore.readNewMessages(roomId, lastRead);
    const participantMap = this.buildParticipantMap();

    // Update cursor to latest
    if (newMsgs.length > 0) {
      const latestSeq = newMsgs[newMsgs.length - 1].seq;
      this.lastReadSequences.set(key, latestSeq);
    }

    return {
      messages: newMsgs.map(m => this.parsedToMessage(roomId, m, participantMap)),
      count: newMsgs.length,
    };
  }

  pinMessage(roomId: string, messageId: string): void {
    // In the file-based system, we pin by sequence number.
    // The messageId in the old system was a UUID, but now we need to find the seq.
    // For backward compatibility, try to interpret messageId as a sequence number,
    // or search for it in the messages.
    const seq = parseInt(messageId, 10);
    if (!isNaN(seq)) {
      const success = this.fileStore.pinMessageBySeq(roomId, seq);
      if (!success) throw new Error(`Message not found: seq #${seq} in room ${roomId}`);
      return;
    }

    // If messageId is not a number, we can't pin it in the file-based system
    throw new Error(
      `Pin by message UUID is not supported in file-based storage. ` +
      `Use the sequence number (e.g., "3") instead of "${messageId}".`,
    );
  }

  searchMessages(roomId: string, query: string, limit?: number): Message[] {
    const results = this.fileStore.searchMessages(roomId, query, limit);
    const participantMap = this.buildParticipantMap();
    return results.map(m => this.parsedToMessage(roomId, m, participantMap));
  }

  deleteMessage(roomId: string, seq: number, reason?: string): boolean {
    const room = this.fileStore.getRoom(roomId);
    if (!room) throw new Error(`Room not found: ${roomId}`);
    return this.fileStore.deleteMessageBySeq(roomId, seq, reason);
  }

  getModerationLevel(roomId: string): string {
    return this.fileStore.getModerationLevel(roomId);
  }

  // ─── Context ───

  getContext(options: ContextOptions): ContextResult {
    const { roomId, maxTokens = 8000, format = 'chat', includeParticipantInfo = true } = options;

    const room = this.fileStore.getRoom(roomId);
    if (!room) throw new Error(`Room not found: ${roomId}`);

    // Read messages (up to room's maxContextMessages)
    const parsed = this.fileStore.readTailMessages(roomId, room.maxContextMessages);
    const pinnedParsed = parsed.filter(m => m.flags.includes('pinned'));

    // Build participant map from file store
    const allParticipants = this.fileStore.loadParticipants();
    const participantMap = new Map<string, Participant>();

    // Add room participants
    const roomParticipants = this.fileStore.getRoomParticipants(roomId);
    for (const p of roomParticipants) {
      const participant = this.fileStore.participantRecordToParticipant(p);
      participantMap.set(participant.id, participant);
    }

    // Also add participants referenced in messages but not in room
    for (const msg of parsed) {
      const record = allParticipants[msg.participant];
      if (record && !participantMap.has(record.id)) {
        participantMap.set(record.id, this.fileStore.participantRecordToParticipant(record));
      }
    }

    // Convert parsed messages to Message type for formatter
    const messages = parsed.map(m => this.parsedToMessage(roomId, m, this.buildParticipantMap()));
    const pinnedMessages = pinnedParsed.map(m => this.parsedToMessage(roomId, m, this.buildParticipantMap()));

    const result = formatContext({
      messages,
      participants: participantMap,
      pinnedMessages,
      format,
      maxTokens,
      roomName: room.name,
    });

    return {
      ...result,
      format,
    };
  }

  // ─── Export / Import ───

  exportRoom(roomId: string, format: 'markdown' | 'json'): string {
    if (format === 'markdown') {
      return this.fileStore.exportRoomMarkdown(roomId);
    }
    return this.fileStore.exportRoomJson(roomId);
  }

  importFromThread(threadId: string, roomId: string): number {
    // Stub — Phase 3 will implement the actual bridge.
    console.error(`[group-chat] importFromThread stub: threadId=${threadId}, roomId=${roomId}`);
    return 0;
  }

  // ─── FileStore accessor (for tools that need direct access) ───

  getFileStore(): FileStore {
    return this.fileStore;
  }

  // ─── Internal Helpers ───

  private buildParticipantMap(): Record<string, ParticipantRecord> {
    return this.fileStore.loadParticipants();
  }

  /**
   * Convert a ParsedMessage (from chat.md) to a Message domain type.
   */
  private parsedToMessage(
    roomId: string,
    parsed: { participant: string; seq: number; timestamp: string; flags: string[]; content: string },
    participantMap: Record<string, ParticipantRecord>,
  ): Message {
    const record = participantMap[parsed.participant];
    const participantId = record?.id || parsed.participant;

    // Extract reply_to from flags
    const replyFlag = parsed.flags.find(f => f.startsWith('reply:'));
    const replyTo = replyFlag ? replyFlag.substring(6) : null;

    return {
      id: `${roomId}:${parsed.seq}`,  // Composite ID since we don't store UUIDs in chat.md
      roomId,
      participantId,
      sequenceNumber: parsed.seq,
      content: parsed.content,
      messageType: 'text',
      replyTo,
      metadata: null,
      isPinned: parsed.flags.includes('pinned'),
      createdAt: new Date(parsed.timestamp).getTime(),
    };
  }
}
