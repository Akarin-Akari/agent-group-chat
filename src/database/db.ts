import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs-extra';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  max_context_messages INTEGER DEFAULT 200,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_archived INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  model TEXT,
  role TEXT DEFAULT 'expert' CHECK(role IN ('orchestrator','expert','reviewer','observer')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_participants (
  room_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  last_read_sequence INTEGER DEFAULT 0,
  PRIMARY KEY (room_id, participant_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  content TEXT NOT NULL,
  message_type TEXT DEFAULT 'text',
  reply_to TEXT,
  metadata TEXT,
  is_pinned INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sequences (
  room_id TEXT PRIMARY KEY,
  current_value INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_messages_room_time ON messages(room_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_room_pinned ON messages(room_id, is_pinned) WHERE is_pinned = 1;
`;

export class DatabaseManager {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || path.join(__dirname, '..', '..', 'data', 'group-chat.db');
  }

  public getDatabase(): Database.Database {
    if (!this.db) {
      this.initialize();
    }
    return this.db!;
  }

  private initialize(): void {
    // Ensure data directory exists
    const dataDir = path.dirname(this.dbPath);
    fs.ensureDirSync(dataDir);

    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    // Run schema
    this.db.exec(SCHEMA_SQL);

    console.error(`[group-chat] Database initialized at ${this.dbPath}`);
  }

  public close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// Singleton instance
export const dbManager = new DatabaseManager();
