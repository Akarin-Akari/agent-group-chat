/**
 * FileStore — "MD 文档即群聊" 核心存储层
 *
 * 每个 room 对应 data/rooms/{id}/ 目录：
 *   - meta.json  房间元数据
 *   - chat.md    聊天记录（ground truth，append-only）
 *
 * 全局参与者注册表：data/participants.json
 *
 * chat.md 格式：
 *   # Room Name
 *   > Description
 *   <!-- msg:participant #seq 2026-03-02T20:00:15 [flags] -->
 *   Message content...
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  Room, Participant, ParticipantRole, Message, MessageType, ModerationLevel,
} from '../types/index.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RoomMeta {
  id: string;
  name: string;
  description: string | null;
  maxContextMessages: number;
  createdAt: string;   // ISO 8601
  updatedAt: string;   // ISO 8601
  isArchived: boolean;
  participants: string[];  // participant names
  sequenceCounter: number;
  moderationLevel: ModerationLevel;
}

export interface ParticipantRecord {
  id: string;
  name: string;
  model: string | null;
  role: ParticipantRole;
  createdAt: string;   // ISO 8601
}

interface ParsedMessage {
  participant: string;
  seq: number;
  timestamp: string;
  flags: string[];
  content: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Regex to parse message header comments in chat.md */
const MSG_HEADER_REGEX = /^<!-- msg:(\S+) #(\d+) ([\dT:.+-]+Z?)(?: (.+))? -->$/;

// ─── FileStore ──────────────────────────────────────────────────────────────

export class FileStore {
  private dataDir: string;
  private roomsDir: string;
  private participantsPath: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir || path.join(__dirname, '..', '..', 'data');
    this.roomsDir = path.join(this.dataDir, 'rooms');
    this.participantsPath = path.join(this.dataDir, 'participants.json');
    this.ensureDirectories();
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    if (!fs.existsSync(this.roomsDir)) {
      fs.mkdirSync(this.roomsDir, { recursive: true });
    }
    if (!fs.existsSync(this.participantsPath)) {
      fs.writeFileSync(this.participantsPath, '{}', 'utf-8');
    }
  }

  // ─── Room Operations ────────────────────────────────────────────────────

  createRoom(name: string, description?: string, maxContextMessages?: number, moderationLevel?: ModerationLevel): Room {
    const id = uuidv4();
    const now = new Date();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();

    const roomDir = path.join(this.roomsDir, id);
    fs.mkdirSync(roomDir, { recursive: true });

    // Write meta.json
    const meta: RoomMeta = {
      id,
      name,
      description: description || null,
      maxContextMessages: maxContextMessages || 200,
      createdAt: nowIso,
      updatedAt: nowIso,
      isArchived: false,
      participants: [],
      sequenceCounter: 0,
      moderationLevel: moderationLevel || 'normal',
    };
    this.writeMetaSafe(roomDir, meta);

    // Write chat.md header
    const chatLines: string[] = [
      `# ${name}`,
      '',
    ];
    if (description) {
      chatLines.splice(1, 0, `> ${description}`, '');
    }
    fs.writeFileSync(path.join(roomDir, 'chat.md'), chatLines.join('\n'), 'utf-8');

    console.error(`[file-store] Created room: ${id} (${name})`);

    return {
      id,
      name,
      description: description || null,
      maxContextMessages: maxContextMessages || 200,
      createdAt: nowMs,
      updatedAt: nowMs,
      isArchived: false,
    };
  }

  listRooms(activeOnly: boolean = false): Room[] {
    if (!fs.existsSync(this.roomsDir)) return [];

    const entries = fs.readdirSync(this.roomsDir, { withFileTypes: true });
    const rooms: Room[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(this.roomsDir, entry.name, 'meta.json');
      if (!fs.existsSync(metaPath)) continue;

      try {
        const meta = this.readMeta(entry.name);
        if (activeOnly && meta.isArchived) continue;
        rooms.push(this.metaToRoom(meta));
      } catch {
        // Skip corrupted rooms
        console.error(`[file-store] Skipping corrupted room: ${entry.name}`);
      }
    }

    // Sort by updatedAt descending
    rooms.sort((a, b) => b.updatedAt - a.updatedAt);
    return rooms;
  }

  getRoom(roomId: string): Room | null {
    try {
      const meta = this.readMeta(roomId);
      return this.metaToRoom(meta);
    } catch {
      return null;
    }
  }

  getRoomMeta(roomId: string): RoomMeta {
    return this.readMeta(roomId);
  }

  updateRoomMeta(roomId: string, updates: Partial<RoomMeta>): void {
    const meta = this.readMeta(roomId);
    const updated = { ...meta, ...updates, updatedAt: new Date().toISOString() };
    const roomDir = path.join(this.roomsDir, roomId);
    this.writeMetaSafe(roomDir, updated);
  }

  updateRoomTimestamp(roomId: string): void {
    this.updateRoomMeta(roomId, {});
  }

  // ─── Message Operations ─────────────────────────────────────────────────

  appendMessage(
    roomId: string,
    participantName: string,
    content: string,
    options?: {
      messageType?: MessageType;
      isPinned?: boolean;
      replyTo?: string;
      metadata?: Record<string, unknown>;
    },
  ): Message {
    const roomDir = path.join(this.roomsDir, roomId);
    const chatPath = path.join(roomDir, 'chat.md');

    if (!fs.existsSync(chatPath)) {
      throw new Error(`Room not found: ${roomId}`);
    }

    // Increment sequence counter atomically
    const meta = this.readMeta(roomId);
    const seq = meta.sequenceCounter + 1;
    const now = new Date();
    const timestamp = now.toISOString();
    const id = uuidv4();

    // Build flags
    const flags: string[] = [];
    if (options?.isPinned) flags.push('pinned');
    if (options?.replyTo) flags.push(`reply:${options.replyTo}`);

    // Build the message block to append
    const flagStr = flags.length > 0 ? ' ' + flags.join(' ') : '';
    const header = `<!-- msg:${participantName} #${seq} ${timestamp}${flagStr} -->`;

    // Append to chat.md (atomic append)
    const block = `\n${header}\n\n${content}\n`;
    fs.appendFileSync(chatPath, block, 'utf-8');

    // Update meta.json
    this.updateRoomMeta(roomId, { sequenceCounter: seq });

    return {
      id,
      roomId,
      participantId: participantName,  // Will be resolved to actual ID by manager
      sequenceNumber: seq,
      content,
      messageType: options?.messageType || 'text',
      replyTo: options?.replyTo || null,
      metadata: options?.metadata || null,
      isPinned: options?.isPinned || false,
      createdAt: now.getTime(),
    };
  }

  readMessages(
    roomId: string,
    options?: { limit?: number; before?: number; after?: number },
  ): { messages: ParsedMessage[]; hasMore: boolean } {
    const chatPath = this.getChatFilePath(roomId);
    if (!fs.existsSync(chatPath)) {
      throw new Error(`Room not found: ${roomId}`);
    }

    const content = fs.readFileSync(chatPath, 'utf-8');
    const allMessages = this.parseChatMd(content);

    // Apply filters
    let filtered = allMessages;
    if (options?.before) {
      filtered = filtered.filter(m => m.seq < options.before!);
    }
    if (options?.after) {
      filtered = filtered.filter(m => m.seq > options.after!);
    }

    const limit = options?.limit || 50;
    const hasMore = filtered.length > limit;
    const sliced = hasMore ? filtered.slice(filtered.length - limit) : filtered;

    return { messages: sliced, hasMore };
  }

  readTailMessages(roomId: string, count: number): ParsedMessage[] {
    const chatPath = this.getChatFilePath(roomId);
    if (!fs.existsSync(chatPath)) {
      throw new Error(`Room not found: ${roomId}`);
    }

    const content = fs.readFileSync(chatPath, 'utf-8');
    const allMessages = this.parseChatMd(content);

    // Return last N messages
    if (allMessages.length <= count) return allMessages;
    return allMessages.slice(allMessages.length - count);
  }

  /**
   * Read messages newer than a given sequence number.
   */
  readNewMessages(roomId: string, afterSequence: number): ParsedMessage[] {
    const chatPath = this.getChatFilePath(roomId);
    if (!fs.existsSync(chatPath)) {
      throw new Error(`Room not found: ${roomId}`);
    }

    const content = fs.readFileSync(chatPath, 'utf-8');
    const allMessages = this.parseChatMd(content);
    return allMessages.filter(m => m.seq > afterSequence);
  }

  /**
   * Search messages by text pattern (grep-like fallback).
   */
  searchMessages(roomId: string, query: string, limit: number = 20): ParsedMessage[] {
    const chatPath = this.getChatFilePath(roomId);
    if (!fs.existsSync(chatPath)) {
      throw new Error(`Room not found: ${roomId}`);
    }

    const content = fs.readFileSync(chatPath, 'utf-8');
    const allMessages = this.parseChatMd(content);
    const lowerQuery = query.toLowerCase();

    const matches = allMessages.filter(m =>
      m.content.toLowerCase().includes(lowerQuery),
    );

    // Return most recent matches first
    return matches.slice(-limit).reverse();
  }

  /**
   * Toggle pin status for a message by sequence number.
   * Modifies the chat.md line in-place.
   */
  pinMessageBySeq(roomId: string, seq: number): boolean {
    const chatPath = this.getChatFilePath(roomId);
    if (!fs.existsSync(chatPath)) return false;

    const content = fs.readFileSync(chatPath, 'utf-8');
    const lines = content.split('\n');
    let modified = false;

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(MSG_HEADER_REGEX);
      if (match && parseInt(match[2], 10) === seq) {
        const currentLine = lines[i];
        if (currentLine.includes(' pinned')) {
          // Already pinned — do nothing (or unpin if needed)
          modified = true;
        } else {
          // Add pinned flag before closing -->
          lines[i] = currentLine.replace(' -->', ' pinned -->');
          modified = true;
        }
        break;
      }
    }

    if (modified) {
      fs.writeFileSync(chatPath, lines.join('\n'), 'utf-8');
    }
    return modified;
  }

  /**
   * Get the absolute path to a room's chat.md file.
   */
  getChatFilePath(roomId: string): string {
    return path.join(this.roomsDir, roomId, 'chat.md');
  }

  /**
   * Get the absolute path to a room's directory.
   */
  getRoomDir(roomId: string): string {
    return path.join(this.roomsDir, roomId);
  }

  /**
   * Get the latest sequence number for a room.
   */
  getLatestSequence(roomId: string): number {
    try {
      const meta = this.readMeta(roomId);
      return meta.sequenceCounter;
    } catch {
      return 0;
    }
  }

  /**
   * Get message count for a room by parsing chat.md headers.
   */
  getMessageCount(roomId: string): number {
    const chatPath = this.getChatFilePath(roomId);
    if (!fs.existsSync(chatPath)) return 0;

    const content = fs.readFileSync(chatPath, 'utf-8');
    const messages = this.parseChatMd(content);
    return messages.length;
  }

  // ─── Participant Operations ─────────────────────────────────────────────

  loadParticipants(): Record<string, ParticipantRecord> {
    if (!fs.existsSync(this.participantsPath)) return {};
    try {
      const raw = fs.readFileSync(this.participantsPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  saveParticipant(participant: ParticipantRecord): void {
    const all = this.loadParticipants();
    all[participant.name] = participant;
    fs.writeFileSync(this.participantsPath, JSON.stringify(all, null, 2), 'utf-8');
  }

  getParticipantByName(name: string): ParticipantRecord | null {
    const all = this.loadParticipants();
    return all[name] || null;
  }

  getParticipantById(id: string): ParticipantRecord | null {
    const all = this.loadParticipants();
    for (const p of Object.values(all)) {
      if (p.id === id) return p;
    }
    return null;
  }

  /**
   * Add a participant to a room's meta.json participants list.
   */
  addRoomParticipant(roomId: string, participantName: string): void {
    const meta = this.readMeta(roomId);
    if (!meta.participants.includes(participantName)) {
      meta.participants.push(participantName);
      const roomDir = path.join(this.roomsDir, roomId);
      this.writeMetaSafe(roomDir, { ...meta, updatedAt: new Date().toISOString() });
    }
  }

  /**
   * Get participants registered in a room.
   */
  getRoomParticipants(roomId: string): ParticipantRecord[] {
    const meta = this.readMeta(roomId);
    const all = this.loadParticipants();
    return meta.participants
      .map(name => all[name])
      .filter((p): p is ParticipantRecord => !!p);
  }

  // ─── Moderation ─────────────────────────────────────────────────────────

  /**
   * Get the moderation level for a room.
   * Returns 'normal' for rooms created before moderationLevel was added.
   */
  getModerationLevel(roomId: string): ModerationLevel {
    try {
      const meta = this.readMeta(roomId);
      return meta.moderationLevel || 'normal';
    } catch {
      return 'normal';
    }
  }

  // ─── Delete Message ────────────────────────────────────────────────────

  /**
   * Delete a message by sequence number from chat.md.
   * The deleted message block is archived to chat.deleted.log.
   *
   * @returns true if the message was found and deleted, false if not found
   */
  deleteMessageBySeq(roomId: string, seq: number, reason?: string): boolean {
    const chatPath = this.getChatFilePath(roomId);
    if (!fs.existsSync(chatPath)) return false;

    const content = fs.readFileSync(chatPath, 'utf-8');
    const lines = content.split('\n');

    // Find the message block: header line + content until next header or EOF
    let blockStart = -1;
    let blockEnd = -1;

    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(MSG_HEADER_REGEX);
      if (match && parseInt(match[2], 10) === seq) {
        blockStart = i;
        // Find end: next header or EOF
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].match(MSG_HEADER_REGEX)) {
            blockEnd = j;
            break;
          }
        }
        if (blockEnd === -1) blockEnd = lines.length;
        break;
      }
    }

    if (blockStart === -1) return false;

    // Extract the deleted block for archival
    const deletedBlock = lines.slice(blockStart, blockEnd).join('\n');

    // Archive to chat.deleted.log
    const roomDir = path.join(this.roomsDir, roomId);
    const deletedLogPath = path.join(roomDir, 'chat.deleted.log');
    const archiveEntry = [
      `<!-- deleted: ${new Date().toISOString()} reason: ${reason || 'no reason given'} -->`,
      deletedBlock,
      '',
    ].join('\n');
    fs.appendFileSync(deletedLogPath, archiveEntry, 'utf-8');

    // Remove the block from chat.md
    // Also remove trailing blank line(s) that were part of the block separator
    let trimEnd = blockEnd;
    while (trimEnd < lines.length && lines[trimEnd].trim() === '') {
      trimEnd++;
      // Only consume one trailing blank line
      break;
    }

    const newLines = [...lines.slice(0, blockStart), ...lines.slice(trimEnd)];
    fs.writeFileSync(chatPath, newLines.join('\n'), 'utf-8');

    console.error(`[file-store] Deleted message #${seq} from room ${roomId}, archived to chat.deleted.log`);
    return true;
  }

  // ─── Export ──────────────────────────────────────────────────────────────

  exportRoomMarkdown(roomId: string): string {
    const chatPath = this.getChatFilePath(roomId);
    if (!fs.existsSync(chatPath)) {
      throw new Error(`Room not found: ${roomId}`);
    }
    return fs.readFileSync(chatPath, 'utf-8');
  }

  exportRoomJson(roomId: string): string {
    const meta = this.readMeta(roomId);
    const chatPath = this.getChatFilePath(roomId);
    const content = fs.readFileSync(chatPath, 'utf-8');
    const messages = this.parseChatMd(content);
    const participants = this.getRoomParticipants(roomId);

    return JSON.stringify({
      room: this.metaToRoom(meta),
      participants: participants.map(p => this.participantRecordToParticipant(p)),
      messages: messages.map(m => ({
        participant: m.participant,
        sequenceNumber: m.seq,
        timestamp: m.timestamp,
        flags: m.flags,
        content: m.content,
      })),
      exportedAt: new Date().toISOString(),
    }, null, 2);
  }

  // ─── Internal Helpers ───────────────────────────────────────────────────

  private readMeta(roomId: string): RoomMeta {
    const metaPath = path.join(this.roomsDir, roomId, 'meta.json');
    if (!fs.existsSync(metaPath)) {
      throw new Error(`Room not found: ${roomId}`);
    }
    const raw = fs.readFileSync(metaPath, 'utf-8');
    return JSON.parse(raw);
  }

  /**
   * Write meta.json safely: write to temp file, then atomic rename.
   */
  private writeMetaSafe(roomDir: string, meta: RoomMeta): void {
    const metaPath = path.join(roomDir, 'meta.json');
    const tmpPath = metaPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(meta, null, 2), 'utf-8');
    fs.renameSync(tmpPath, metaPath);
  }

  /**
   * Parse chat.md content into structured messages.
   *
   * Format: <!-- msg:participant #seq timestamp [flags] -->
   * Followed by blank line, then message content, until next header or EOF.
   */
  parseChatMd(content: string): ParsedMessage[] {
    const lines = content.split('\n');
    const messages: ParsedMessage[] = [];
    let current: ParsedMessage | null = null;
    let contentLines: string[] = [];

    for (const line of lines) {
      const match = line.match(MSG_HEADER_REGEX);
      if (match) {
        // Save previous message
        if (current) {
          current.content = this.trimMessageContent(contentLines);
          messages.push(current);
        }

        // Parse flags
        const flagStr = match[4] || '';
        const flags = flagStr.split(/\s+/).filter(Boolean);

        current = {
          participant: match[1],
          seq: parseInt(match[2], 10),
          timestamp: match[3],
          flags,
          content: '',
        };
        contentLines = [];
      } else if (current) {
        contentLines.push(line);
      }
    }

    // Don't forget the last message
    if (current) {
      current.content = this.trimMessageContent(contentLines);
      messages.push(current);
    }

    return messages;
  }

  /**
   * Trim leading/trailing blank lines from message content.
   */
  private trimMessageContent(lines: string[]): string {
    // Remove leading empty lines
    while (lines.length > 0 && lines[0].trim() === '') {
      lines.shift();
    }
    // Remove trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    return lines.join('\n');
  }

  /**
   * Convert RoomMeta to Room domain type.
   */
  metaToRoom(meta: RoomMeta): Room {
    return {
      id: meta.id,
      name: meta.name,
      description: meta.description,
      maxContextMessages: meta.maxContextMessages,
      createdAt: new Date(meta.createdAt).getTime(),
      updatedAt: new Date(meta.updatedAt).getTime(),
      isArchived: meta.isArchived,
    };
  }

  /**
   * Convert ParticipantRecord to Participant domain type.
   */
  participantRecordToParticipant(record: ParticipantRecord): Participant {
    return {
      id: record.id,
      name: record.name,
      model: record.model,
      role: record.role,
      createdAt: new Date(record.createdAt).getTime(),
    };
  }
}
