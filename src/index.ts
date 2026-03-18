import fs from 'fs';
import path from 'path';
import { FileStore } from './storage/file-store.js';
import { GroupChatServer } from './server.js';
import { migrateFromSqlite } from './storage/migrate.js';

// ── Auto-migration: SQLite → MD files ───────────────────────────────────────
// If SQLite database exists but rooms directory is empty/missing,
// automatically migrate data from SQLite to the new file-based format.

const dataDir = path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'group-chat.db');
const roomsDir = path.join(dataDir, 'rooms');

function shouldMigrate(): boolean {
  if (!fs.existsSync(dbPath)) return false;
  if (!fs.existsSync(roomsDir)) return true;
  // If rooms dir exists but is empty, still migrate
  const entries = fs.readdirSync(roomsDir);
  return entries.length === 0;
}

if (shouldMigrate()) {
  console.error('[group-chat] Detected SQLite database without MD files. Running auto-migration...');
  const result = migrateFromSqlite(dbPath, dataDir);
  console.error(
    `[group-chat] Migration complete: ${result.rooms} rooms, ${result.participants} participants, ${result.messages} messages`,
  );
  if (result.errors.length > 0) {
    console.error(`[group-chat] ⚠️ Migration had ${result.errors.length} error(s).`);
  }
}

// ── Start server ────────────────────────────────────────────────────────────

const fileStore = new FileStore(dataDir);
const server = new GroupChatServer(fileStore);

async function main() {
  try {
    await server.start();
  } catch (error) {
    console.error('[group-chat] Fatal error:', error);
    process.exit(1);
  }
}

main();
