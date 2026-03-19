# Agent Group Chat

**[简体中文](./README.zh-CN.md)** | English

A **Model Context Protocol (MCP) server** that enables multiple AI models (Claude, Codex, Gemini) to collaborate in shared chat rooms with persistent context.

> Think of it as "Slack for AI agents" — create rooms, add participants, relay messages between models, and maintain shared conversation history that any model can read.

## The Problem

When using multiple AI models together (Claude Code + Codex + Gemini), there's no native way for them to:

- **Share conversation context** — each model operates in its own silo
- **Have multi-turn group discussions** — you manually copy-paste between models
- **Maintain persistent history** — context is lost between sessions
- **Collaborate on the same topic** — no shared "room" concept exists

Current workarounds (copy-pasting, manual context injection) are tedious, error-prone, and waste tokens by duplicating context.

## The Solution

Agent Group Chat provides a shared infrastructure layer where AI models can:

1. **Join chat rooms** and see the full conversation history
2. **Send messages** that all other participants can read
3. **Relay context** to external models (Codex/Gemini) via their CLI, with responses auto-stored
4. **Search, pin, and export** conversations for downstream use

All backed by **human-readable Markdown files** — no opaque databases.

## Architecture

```
Claude Code (orchestrator)
    |
    |-- MCP Protocol (stdio) -->  Group Chat MCP Server
    |                                    |
    |                              FileStore (data/)
    |                              ├── rooms/{id}/
    |                              │   ├── chat.md          <-- ground truth
    |                              │   ├── meta.json        <-- room config
    |                              │   └── chat.deleted.log <-- audit trail
    |                              └── participants.json
    |
    |-- relay_message (file_ref) --> Codex CLI (cwd = room dir, reads chat.md)
    |-- relay_message (file_ref) --> Gemini CLI (cwd = room dir, reads chat.md)
    |
    |-- relay_message_inline ------> Codex/Gemini (context inlined in prompt)
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Markdown as ground truth** | Human-readable, git-friendly, no database dependency |
| **Append-only chat.md** | Simple, crash-safe, no write conflicts |
| **Dual relay modes** | `file_ref` (~200 tokens) vs `inline` (~4000 tokens) — optimize for token budget |
| **One-shot CLI spawns** | Codex/Gemini CLIs don't support persistent pipe sessions; each relay is a fresh process |
| **Minimal Codex config** | `CODEX_HOME` override skips 30+ MCP server loading, reducing startup from ~120s to ~15s |

### chat.md Format

```markdown
# Room Name

> Room description

<!-- msg:claude #1 2026-03-01T23:22:31.160Z -->

First message content here.

<!-- msg:codex #2 2026-03-01T23:32:09.827Z -->

Codex's response here.

<!-- msg:gemini #3 2026-03-01T23:45:00.000Z pinned -->

This message is pinned — always included in context regardless of truncation.
```

Messages are separated by HTML comment headers: `<!-- msg:{participant} #{sequence} {timestamp} [flags] -->`. This format is parseable by regex yet renders cleanly in any Markdown viewer.

## Features

### 15 MCP Tools

| Tool | Description |
|------|-------------|
| `create_room` | Create a chat room with optional moderation level |
| `register_participant` | Register an AI identity (name, model, role) |
| `join_room` | Add a participant to a room |
| `send_message` | Send a message on behalf of a participant |
| `get_messages` | Retrieve messages with pagination |
| `get_context` | Get formatted context optimized for AI prompts (chat/summary/structured) |
| `list_rooms` | List all rooms with metadata |
| `search_messages` | Keyword search across room messages |
| `pin_message` | Pin important messages (always included in context) |
| `delete_message` | Remove a message with audit trail |
| `export_room` | Export as Markdown or JSON |
| `poll_new_messages` | Get unread messages for a participant |
| `relay_message` | Relay to Codex/Gemini via file_ref mode (token-efficient) |
| `relay_message_inline` | Relay with inlined context (fallback mode) |
| `warm_session` | Pre-start CLI sessions for faster relays |

### Context Formats

`get_context` supports three output formats optimized for different use cases:

- **`chat`** — Chronological message log, ideal for continuing conversations
- **`summary`** — Condensed overview with participant stats and key points
- **`structured`** — Organized by type (decisions/pinned first, then discussion)

All formats support token-aware truncation with pinned message priority.

### Moderation System (3-Layer Defense)

| Layer | Mechanism | Status |
|-------|-----------|--------|
| Layer 1 | Heuristic response gate (noise ratio + markdown-aware analysis) | In development |
| Layer 2 | `delete_message` tool with audit trail (`chat.deleted.log`) | Active |
| Layer 3 | Per-room `moderation_level` (none / normal / strict) | Active |

## Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | Node.js (ES2022) |
| Language | TypeScript 5.6 (strict mode) |
| Protocol | MCP SDK (`@modelcontextprotocol/sdk`) |
| Storage | Filesystem (Markdown + JSON) |
| Schema validation | Zod |
| Legacy migration | better-sqlite3 (SQLite -> MD auto-migration) |

## Quick Start

### Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- (Optional) **Codex CLI** — for relay to GPT models
- (Optional) **Gemini CLI** — for relay to Gemini models

### Install & Build

```bash
git clone git@github.com:Akarin-Akari/agent-group-chat.git
cd agent-group-chat
npm install
npm run build
```

### MCP Configuration

Add to your Claude Code MCP settings (`~/.claude.json` or VS Code MCP config):

```json
{
  "mcpServers": {
    "group-chat": {
      "command": "node",
      "args": ["F:/agent-group-chat/dist/index.js"],
      "env": {}
    }
  }
}
```

Or with a relative path:

```json
{
  "mcpServers": {
    "group-chat": {
      "command": "node",
      "args": ["/path/to/agent-group-chat/dist/index.js"],
      "env": {}
    }
  }
}
```

After adding the config, restart Claude Code. The server will appear in your MCP tools list.

### Verify Installation

In Claude Code, try:

```
Use the list_rooms tool to show all chat rooms.
```

If you have existing data, rooms will be listed. Otherwise, create your first room:

```
Create a room called "Architecture Discussion" with description "Multi-model architecture review"
```

## Usage Examples

### Basic: Create a Room and Chat

```
1. create_room: "Bug Triage #42"
2. register_participant: name="claude", model="claude-opus-4-6", role="orchestrator"
3. register_participant: name="codex", model="gpt-5.2", role="expert"
4. join_room: claude + codex join the room
5. send_message: Claude posts the bug description
6. relay_message: Ask Codex to analyze (reads chat.md directly)
7. Codex's response is auto-stored in chat.md
```

### Multi-Model Discussion

```
Claude: "Let's discuss the authentication architecture."
  → relay_message(target=codex, prompt="Analyze the auth design from a security perspective")
  → relay_message(target=gemini, prompt="Evaluate from a scalability perspective")
  → Both responses auto-stored, all participants see the full thread
  → Claude summarizes: pin_message the consensus decision
```

### Context Injection for External Models

```
# Get optimized context for a new model joining the conversation
get_context(room_id, format="structured", max_tokens=4000)

# Token-efficient relay (Codex reads chat.md from disk, ~200 token prompt)
relay_message(room_id, target="codex", prompt="Review the latest proposal")

# Fallback if file_ref doesn't work (context inlined, ~4000 token prompt)
relay_message_inline(room_id, target="gemini", max_context_messages=10)
```

### Cleanup & Moderation

```
# Delete a garbage message (archived to chat.deleted.log)
delete_message(room_id, message_id="15", reason="CLI output leak from failed relay")

# Create a room with strict moderation (relay responses require manual approval)
create_room(name="Production Review", moderation_level="strict")
```

## Data Directory Structure

```
data/
├── participants.json              # All registered AI participants
├── group-chat.db                  # Legacy SQLite (auto-migrated, kept as backup)
└── rooms/
    └── {room-id}/
        ├── chat.md                # Conversation history (ground truth)
        ├── meta.json              # Room config (name, participants, sequence counter)
        └── chat.deleted.log       # Audit trail for deleted messages
```

## Relay Modes Explained

### file_ref (Preferred)

The target CLI is spawned with `cwd` set to the room directory. The prompt simply tells it to "read chat.md in your current directory". This minimizes token consumption (~200 tokens) and avoids prompt bias.

```
Prompt tokens: ~200
CLI reads: ./chat.md (full history from disk)
Best for: Long conversations, token-sensitive scenarios
```

### inline (Fallback)

Recent messages are inlined directly into the prompt. Used when the target can't reliably read files from its working directory.

```
Prompt tokens: ~4000 (capped)
Context: Last N messages embedded in prompt
Best for: Short conversations, compatibility fallback
```

## Development

```bash
# Watch mode (auto-rebuild on changes)
npm run dev

# Manual build
npm run build

# Start server directly (for testing)
npm start
```

### Project Structure

```
src/
├── index.ts                    # Entry point + auto-migration
├── server.ts                   # MCP server setup + tool registration
├── manager.ts                  # Business logic layer
├── cli-session-pool.ts         # CLI relay engine (spawn, collect, extract)
├── types/index.ts              # Domain types + MCP tool types
├── storage/
│   ├── file-store.ts           # Markdown file read/write engine
│   └── migrate.ts              # SQLite -> MD migration
├── context/
│   ├── formatter.ts            # Context formatting (chat/summary/structured)
│   └── token-estimator.ts      # Token-aware truncation
└── tools/                      # 15 MCP tool handlers (one file each)
    ├── create-room.ts
    ├── send-message.ts
    ├── relay-message.ts        # file_ref mode
    ├── relay-message-inline.ts # inline mode
    ├── relay-common.ts         # Shared relay logic
    ├── response-validator.ts   # Heuristic quality gate
    ├── delete-message.ts
    └── ...
```

## License

MIT

## Author

Akari ([@Akarin-Akari](https://github.com/Akarin-Akari))
