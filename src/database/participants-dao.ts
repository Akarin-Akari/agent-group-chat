import { Database } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { Participant, ParticipantRole } from '../types/index.js';
import { DatabaseManager } from './db.js';

export class ParticipantsDAO {
  private dbManager: DatabaseManager;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  private get db(): Database {
    return this.dbManager.getDatabase();
  }

  public create(name: string, model?: string, role?: ParticipantRole): Participant {
    const id = uuidv4();
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO participants (id, name, model, role, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(id, name, model || null, role || 'expert', now);

    return {
      id,
      name,
      model: model || null,
      role: role || 'expert',
      createdAt: now,
    };
  }

  public findById(id: string): Participant | null {
    const row = this.db.prepare('SELECT * FROM participants WHERE id = ?').get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  public findByName(name: string): Participant | null {
    const row = this.db.prepare('SELECT * FROM participants WHERE name = ?').get(name) as any;
    return row ? this.mapRow(row) : null;
  }

  public findAll(): Participant[] {
    const rows = this.db.prepare('SELECT * FROM participants ORDER BY created_at').all() as any[];
    return rows.map(this.mapRow);
  }

  // ─── Room Membership ───

  public joinRoom(roomId: string, participantId: string): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO room_participants (room_id, participant_id, joined_at, last_read_sequence)
      VALUES (?, ?, ?, 0)
    `);
    stmt.run(roomId, participantId, Date.now());
  }

  public getRoomParticipants(roomId: string): Participant[] {
    const rows = this.db.prepare(`
      SELECT p.* FROM participants p
      JOIN room_participants rp ON p.id = rp.participant_id
      WHERE rp.room_id = ?
      ORDER BY rp.joined_at
    `).all(roomId) as any[];
    return rows.map(this.mapRow);
  }

  public getLastReadSequence(roomId: string, participantId: string): number {
    const row = this.db.prepare(
      'SELECT last_read_sequence FROM room_participants WHERE room_id = ? AND participant_id = ?'
    ).get(roomId, participantId) as any;
    return row ? row.last_read_sequence : 0;
  }

  public updateLastReadSequence(roomId: string, participantId: string, sequence: number): void {
    this.db.prepare(
      'UPDATE room_participants SET last_read_sequence = ? WHERE room_id = ? AND participant_id = ?'
    ).run(sequence, roomId, participantId);
  }

  private mapRow(row: any): Participant {
    return {
      id: row.id,
      name: row.name,
      model: row.model,
      role: row.role as ParticipantRole,
      createdAt: row.created_at,
    };
  }
}
