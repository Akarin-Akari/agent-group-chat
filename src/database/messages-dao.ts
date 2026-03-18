import { Database } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { Message, MessageType } from '../types/index.js';
import { DatabaseManager } from './db.js';

export class MessagesDAO {
  private dbManager: DatabaseManager;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  private get db(): Database {
    return this.dbManager.getDatabase();
  }

  /**
   * Atomically increment the room's sequence counter and return the new value.
   */
  private nextSequence(roomId: string): number {
    const stmt = this.db.prepare(
      'UPDATE sequences SET current_value = current_value + 1 WHERE room_id = ? RETURNING current_value'
    );
    const row = stmt.get(roomId) as any;
    if (!row) {
      // Room sequence not initialized — create it
      this.db.prepare('INSERT OR IGNORE INTO sequences (room_id, current_value) VALUES (?, 1)').run(roomId);
      return 1;
    }
    return row.current_value;
  }

  public create(
    roomId: string,
    participantId: string,
    content: string,
    messageType: MessageType = 'text',
    replyTo?: string,
    metadata?: Record<string, unknown>
  ): Message {
    const id = uuidv4();
    const now = Date.now();
    const seq = this.nextSequence(roomId);

    const stmt = this.db.prepare(`
      INSERT INTO messages (id, room_id, participant_id, sequence_number, content, message_type, reply_to, metadata, is_pinned, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);
    stmt.run(id, roomId, participantId, seq, content, messageType, replyTo || null, metadata ? JSON.stringify(metadata) : null, now);

    return {
      id,
      roomId,
      participantId,
      sequenceNumber: seq,
      content,
      messageType,
      replyTo: replyTo || null,
      metadata: metadata || null,
      isPinned: false,
      createdAt: now,
    };
  }

  public findByRoom(
    roomId: string,
    options?: { limit?: number; before?: number; after?: number }
  ): { messages: Message[]; hasMore: boolean } {
    const limit = options?.limit || 50;
    const conditions: string[] = ['room_id = ?'];
    const params: any[] = [roomId];

    if (options?.before) {
      conditions.push('sequence_number < ?');
      params.push(options.before);
    }
    if (options?.after) {
      conditions.push('sequence_number > ?');
      params.push(options.after);
    }

    // Fetch one extra to determine hasMore
    params.push(limit + 1);

    const sql = `
      SELECT * FROM messages
      WHERE ${conditions.join(' AND ')}
      ORDER BY sequence_number ASC
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params) as any[];
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;

    return {
      messages: sliced.map(this.mapRow),
      hasMore,
    };
  }

  public findNewMessages(roomId: string, afterSequence: number): Message[] {
    const rows = this.db.prepare(
      'SELECT * FROM messages WHERE room_id = ? AND sequence_number > ? ORDER BY sequence_number ASC'
    ).all(roomId, afterSequence) as any[];
    return rows.map(this.mapRow);
  }

  public findPinned(roomId: string): Message[] {
    const rows = this.db.prepare(
      'SELECT * FROM messages WHERE room_id = ? AND is_pinned = 1 ORDER BY sequence_number ASC'
    ).all(roomId) as any[];
    return rows.map(this.mapRow);
  }

  public pin(roomId: string, messageId: string): boolean {
    const result = this.db.prepare(
      'UPDATE messages SET is_pinned = 1 WHERE id = ? AND room_id = ?'
    ).run(messageId, roomId);
    return result.changes > 0;
  }

  public unpin(roomId: string, messageId: string): boolean {
    const result = this.db.prepare(
      'UPDATE messages SET is_pinned = 0 WHERE id = ? AND room_id = ?'
    ).run(messageId, roomId);
    return result.changes > 0;
  }

  public search(roomId: string, query: string, limit: number = 20): Message[] {
    // Simple LIKE-based search. Phase 2 will add embedding-based semantic search.
    const pattern = `%${query}%`;
    const rows = this.db.prepare(
      'SELECT * FROM messages WHERE room_id = ? AND content LIKE ? ORDER BY sequence_number DESC LIMIT ?'
    ).all(roomId, pattern, limit) as any[];
    return rows.map(this.mapRow);
  }

  public findById(id: string): Message | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  public getMessageCount(roomId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE room_id = ?').get(roomId) as any;
    return row.count;
  }

  public getLatestSequence(roomId: string): number {
    const row = this.db.prepare(
      'SELECT current_value FROM sequences WHERE room_id = ?'
    ).get(roomId) as any;
    return row ? row.current_value : 0;
  }

  private mapRow(row: any): Message {
    return {
      id: row.id,
      roomId: row.room_id,
      participantId: row.participant_id,
      sequenceNumber: row.sequence_number,
      content: row.content,
      messageType: row.message_type as MessageType,
      replyTo: row.reply_to,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
      isPinned: !!row.is_pinned,
      createdAt: row.created_at,
    };
  }
}
