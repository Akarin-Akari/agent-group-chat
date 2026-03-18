import { Database } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { Room } from '../types/index.js';
import { DatabaseManager } from './db.js';

export class RoomsDAO {
  private dbManager: DatabaseManager;

  constructor(dbManager: DatabaseManager) {
    this.dbManager = dbManager;
  }

  private get db(): Database {
    return this.dbManager.getDatabase();
  }

  public create(name: string, description?: string, maxContextMessages?: number): Room {
    const id = uuidv4();
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO rooms (id, name, description, max_context_messages, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, name, description || null, maxContextMessages || 200, now, now);

    // Initialize sequence counter for this room
    this.db.prepare('INSERT INTO sequences (room_id, current_value) VALUES (?, 0)').run(id);

    return {
      id,
      name,
      description: description || null,
      maxContextMessages: maxContextMessages || 200,
      createdAt: now,
      updatedAt: now,
      isArchived: false,
    };
  }

  public findById(id: string): Room | null {
    const row = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as any;
    return row ? this.mapRow(row) : null;
  }

  public findAll(activeOnly: boolean = false): Room[] {
    const sql = activeOnly
      ? 'SELECT * FROM rooms WHERE is_archived = 0 ORDER BY updated_at DESC'
      : 'SELECT * FROM rooms ORDER BY updated_at DESC';
    const rows = this.db.prepare(sql).all() as any[];
    return rows.map(this.mapRow);
  }

  public updateTimestamp(id: string): void {
    this.db.prepare('UPDATE rooms SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  public archive(id: string): void {
    this.db.prepare('UPDATE rooms SET is_archived = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  private mapRow(row: any): Room {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      maxContextMessages: row.max_context_messages,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      isArchived: !!row.is_archived,
    };
  }
}
