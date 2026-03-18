/**
 * migrate.ts — SQLite → MD file migration script.
 *
 * Reads all rooms, participants, and messages from the existing SQLite database
 * and writes them to the new file-based storage format:
 *   data/rooms/{id}/meta.json
 *   data/rooms/{id}/chat.md
 *   data/participants.json
 *
 * Usage:
 *   npx ts-node src/storage/migrate.ts
 *   — or —
 *   node dist/storage/migrate.js
 */

import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { FileStore, RoomMeta, ParticipantRecord } from './file-store.js';

interface SqliteRoom {
  id: string;
  name: string;
  description: string | null;
  max_context_messages: number;
  created_at: number;
  updated_at: number;
  is_archived: number;
}

interface SqliteParticipant {
  id: string;
  name: string;
  model: string | null;
  role: string;
  created_at: number;
}

interface SqliteMessage {
  id: string;
  room_id: string;
  participant_id: string;
  sequence_number: number;
  content: string;
  message_type: string;
  reply_to: string | null;
  metadata: string | null;
  is_pinned: number;
  created_at: number;
}

interface SqliteRoomParticipant {
  room_id: string;
  participant_id: string;
  joined_at: number;
  last_read_sequence: number;
}

/**
 * Migrate all data from SQLite to MD file storage.
 */
export function migrateFromSqlite(dbPath?: string, dataDir?: string): {
  rooms: number;
  participants: number;
  messages: number;
  errors: string[];
} {
  const resolvedDbPath = dbPath || path.join(__dirname, '..', '..', 'data', 'group-chat.db');
  const resolvedDataDir = dataDir || path.join(__dirname, '..', '..', 'data');

  if (!fs.existsSync(resolvedDbPath)) {
    console.error(`[migrate] Database not found at ${resolvedDbPath}. Nothing to migrate.`);
    return { rooms: 0, participants: 0, messages: 0, errors: ['Database file not found'] };
  }

  const db = new Database(resolvedDbPath, { readonly: true });
  const errors: string[] = [];
  let roomCount = 0;
  let participantCount = 0;
  let messageCount = 0;

  try {
    // ── 1. Migrate participants ─────────────────────────────────────────────
    console.error('[migrate] Migrating participants...');
    const participants = db.prepare('SELECT * FROM participants').all() as SqliteParticipant[];
    const participantMap: Record<string, SqliteParticipant> = {};

    const allParticipants: Record<string, ParticipantRecord> = {};
    for (const p of participants) {
      participantMap[p.id] = p;
      allParticipants[p.name] = {
        id: p.id,
        name: p.name,
        model: p.model,
        role: p.role as any,
        createdAt: new Date(p.created_at).toISOString(),
      };
      participantCount++;
    }

    const participantsPath = path.join(resolvedDataDir, 'participants.json');
    fs.writeFileSync(participantsPath, JSON.stringify(allParticipants, null, 2), 'utf-8');
    console.error(`[migrate] Migrated ${participantCount} participants.`);

    // ── 2. Migrate rooms ────────────────────────────────────────────────────
    console.error('[migrate] Migrating rooms...');
    const rooms = db.prepare('SELECT * FROM rooms').all() as SqliteRoom[];

    for (const room of rooms) {
      try {
        const roomDir = path.join(resolvedDataDir, 'rooms', room.id);
        fs.mkdirSync(roomDir, { recursive: true });

        // Get room participants
        const roomParticipants = db.prepare(
          'SELECT * FROM room_participants WHERE room_id = ?',
        ).all(room.id) as SqliteRoomParticipant[];
        const participantNames = roomParticipants
          .map(rp => participantMap[rp.participant_id]?.name)
          .filter(Boolean) as string[];

        // Get latest sequence
        const seqRow = db.prepare(
          'SELECT current_value FROM sequences WHERE room_id = ?',
        ).get(room.id) as { current_value: number } | undefined;
        const sequenceCounter = seqRow?.current_value || 0;

        // Write meta.json
        const meta: RoomMeta = {
          id: room.id,
          name: room.name,
          description: room.description,
          maxContextMessages: room.max_context_messages,
          createdAt: new Date(room.created_at).toISOString(),
          updatedAt: new Date(room.updated_at).toISOString(),
          isArchived: !!room.is_archived,
          participants: participantNames,
          sequenceCounter,
          moderationLevel: 'normal',
        };
        // Write to temp then rename for atomicity
        const metaPath = path.join(roomDir, 'meta.json');
        const metaTmpPath = metaPath + '.tmp';
        fs.writeFileSync(metaTmpPath, JSON.stringify(meta, null, 2), 'utf-8');
        fs.renameSync(metaTmpPath, metaPath);

        // Get messages for this room
        const messages = db.prepare(
          'SELECT * FROM messages WHERE room_id = ? ORDER BY sequence_number ASC',
        ).all(room.id) as SqliteMessage[];

        // Build chat.md
        const chatLines: string[] = [];
        chatLines.push(`# ${room.name}`);
        if (room.description) {
          chatLines.push('');
          chatLines.push(`> ${room.description}`);
        }
        chatLines.push('');

        for (const msg of messages) {
          const participantName = participantMap[msg.participant_id]?.name || 'unknown';
          const timestamp = new Date(msg.created_at).toISOString();

          // Build flags
          const flags: string[] = [];
          if (msg.is_pinned) flags.push('pinned');
          if (msg.reply_to) flags.push(`reply:${msg.reply_to}`);
          const flagStr = flags.length > 0 ? ' ' + flags.join(' ') : '';

          chatLines.push(`<!-- msg:${participantName} #${msg.sequence_number} ${timestamp}${flagStr} -->`);
          chatLines.push('');
          chatLines.push(msg.content);
          chatLines.push('');

          messageCount++;
        }

        fs.writeFileSync(path.join(roomDir, 'chat.md'), chatLines.join('\n'), 'utf-8');
        roomCount++;

        console.error(
          `[migrate] Room "${room.name}" (${room.id}): ` +
          `${messages.length} messages, ${participantNames.length} participants`,
        );
      } catch (err: any) {
        const errMsg = `Failed to migrate room ${room.id} (${room.name}): ${err.message}`;
        console.error(`[migrate] ❌ ${errMsg}`);
        errors.push(errMsg);
      }
    }

    console.error(`[migrate] ✅ Migration complete: ${roomCount} rooms, ${participantCount} participants, ${messageCount} messages`);
    if (errors.length > 0) {
      console.error(`[migrate] ⚠️ ${errors.length} error(s) occurred during migration.`);
    }
  } finally {
    db.close();
  }

  return { rooms: roomCount, participants: participantCount, messages: messageCount, errors };
}

// ── Run directly ──────────────────────────────────────────────────────────

if (require.main === module) {
  console.error('[migrate] Starting SQLite → MD file migration...');
  const result = migrateFromSqlite();
  console.error('[migrate] Result:', JSON.stringify(result, null, 2));
  process.exit(result.errors.length > 0 ? 1 : 0);
}
