# Group Chat MCP Server v2.0 - Functional Test Report

> **Tester**: Claude Opus 4.6 (session: 2026-03-19)
>
> **Test Plan**: `docs/2026-03-03-functional-test-plan.md`
>
> **Date**: 2026-03-19
>
> **Overall Result**: **PASS** (with 1 bug found and fixed, 1 known limitation)

---

## Phase 0: Auto-Migration Verification

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 0.1 | `data/rooms/` created | PASS | 3 room directories |
| 0.2 | Each room has `meta.json` + `chat.md` | PASS | 6 files total |
| 0.3 | `data/participants.json` created | PASS | claude, codex, gemini |
| 0.4 | Room metadata integrity | PASS | name, description, participants, sequenceCounter all correct |
| 0.5 | chat.md format | PASS | `<!-- msg:name #seq timestamp -->` HTML comment separators |
| 0.6 | Message count consistency | PASS | Iran News: 10 msgs (seq #1-#9, #13), Architecture: 6, Daily News: 6 |
| 0.7 | Pinned messages | N/A | No pinned messages in original data |

**Note**: Iran News room has sequence gap (#10-#12 missing) - this is correct behavior, the original SQLite data had this gap. `sequenceCounter=13` matches last message.

---

## Phase 1: Basic CRUD

| # | Test | Result | Details |
|---|------|--------|---------|
| 1.1 | create_room | PASS | Created "Phase 1 CRUD Test Room" (`db9d0e2a`), `meta.json` + `chat.md` generated |
| 1.2 | register_participant | PASS | Registered "test-bot" with role=observer, model=test-model-v1 |
| 1.3 | join_room | PASS | test-bot joined new room, participants array updated |
| 1.4 | send_message | PASS | Sequence #1 assigned, chat.md appended correctly. Also tested with Iran room: #14 correct |
| 1.5 | get_messages | PASS | Returns parsed messages matching chat.md content |
| 1.6 | get_context (chat) | PASS | Formatted chat output, token estimation ~1652 |
| 1.7 | list_rooms | PASS | 4 rooms listed (3 migrated + 1 new), metadata complete |
| 1.8 | search_messages | PASS | Searched "霍尔木兹" in Iran room, returned 4 relevant results |
| 1.9 | export_room (json) | PASS | 9303 characters exported |
| 1.10 | pin_message | PASS | Pinned #6 in Iran room, `pinned` marker added to chat.md |
| 1.11 | poll_new_messages | PASS | Codex perspective: 11 unread messages, pinned #6 shows pin icon |

---

## Phase 2: Relay

| # | Test | Result | Details |
|---|------|--------|---------|
| 2.1 | warm_session (codex) | PASS | 15.6s warm-up |
| 2.2 | warm_session (gemini) | FAIL (expected) | Gemini CLI not installed on this machine |
| 2.3 | relay_message file_ref (codex) | **PASS (after bugfix)** | BUG-001 found and fixed. Post-fix: 73.5s, high-quality Chinese response, seq #17 |
| 2.4 | relay_message_inline (codex) | PASS | 43.5s, 671 chars response, seq #18 |
| 2.5 | Response auto-storage | PASS | Both relay responses correctly appended to chat.md with proper sequence numbers |
| 2.6 | relay_message (gemini) | SKIP | Gemini CLI not installed |

---

## Phase 3: Advanced Features

| # | Test | Result | Details |
|---|------|--------|---------|
| 3.1 | get_context format=summary | PASS | Auto-generated summary with participant stats, contributions, pinned key points |
| 3.2 | get_context format=structured | PASS | DECISIONS section shows pinned msgs, DISCUSSION shows chronological, truncation works |
| 3.3 | get_context format=chat max_tokens=500 | PASS | **Key validation**: Pinned messages (#6, #17) preserved in full despite extreme token limit |
| 3.4 | pin_message #17 (second pin) | PASS | Multiple pins coexist correctly |
| 3.5 | export_room markdown | PASS | 10551 characters, complete format |
| 3.6 | Pin priority in context | PASS | Pinned messages always appear first regardless of truncation settings |

---

## Phase 3 (Test Plan): Migration Data Integrity

| # | Test | Result | Details |
|---|------|--------|---------|
| 3.1 | Iran News room integrity | PASS | 10 messages, correct participants, metadata complete |
| 3.2 | Participant data integrity | PASS | 3 participants with correct IDs, models, roles |
| 3.3 | Discussion continuation | PASS | Successfully sent #14 (Claude), received #17 (Codex file_ref), #18 (Codex inline) |

---

## Bug Report

### BUG-001: relay_message file_ref mode - Wrong cwd (FIXED)

**Severity**: HIGH
**Status**: FIXED

**Description**: `cli-session-pool.ts:258` hardcoded `cwd` to `process.env.USERPROFILE` (user home directory) instead of the room directory. This caused Codex to be unable to find `chat.md`, wasting 300s searching the entire home directory before timing out.

**Root Cause**: `runCli()` function did not accept a `cwd` parameter. The `relay-message.ts` comments stated "Sets the spawned CLI's cwd to the room directory" but no such parameter was passed.

**Fix** (3 files changed):

1. `src/cli-session-pool.ts`:
   - `runCli(target, prompt)` -> `runCli(target, prompt, cwd?)`
   - `CliSessionPool.relay(target, prompt)` -> `relay(target, prompt, cwd?)`
   - `cwd: process.env.USERPROFILE` -> `cwd: cwd || process.env.USERPROFILE`

2. `src/tools/relay-common.ts`:
   - `executeRelayAndStore(...)` added optional `cwd` parameter
   - Passes `cwd` to `pool.relay()`

3. `src/tools/relay-message.ts`:
   - Gets room directory via `fileStore.getRoomDir(room_id)`
   - Passes `roomDir` as `cwd` to `executeRelayAndStore()`

**Verification**: After fix, Codex correctly reads chat.md from room directory (73.5s vs 300s timeout).

---

## Known Issues / Recommendations

1. **Garbage messages from BUG-001**: Messages #15 and #16 in the Iran News room contain Codex's failed file search logs (pre-fix). These pollute context/search results. **Recommendation**: Add `delete_message` or `archive_message` tool for cleanup.

2. **Gemini CLI not installed**: All Gemini relay tests were skipped. This is an environment issue, not a code bug.

3. **participant_id requires UUID**: `send_message` requires participant UUID, not name string. The error message is clear ("Participant not found: claude"), but this could be improved with name-to-ID auto-resolution.

4. **Codex minimal config**: The `CODEX_HOME` override to avoid loading 30+ MCP servers works well (startup reduced from ~120s to ~15s). Model set to `gpt-5.3-codex` in minimal config.

---

## Regression Checklist

- [x] **Auto-migration**: SQLite -> MD file migration executed correctly
- [x] **Create room**: Directory structure + meta.json + chat.md generated correctly
- [x] **Register participant**: participants.json written correctly
- [x] **Join room**: meta.json participants array updated correctly
- [x] **Send message**: chat.md append-only write, correct format
- [x] **Read messages**: Parse chat.md returns correct message array
- [x] **Get context**: Formatted output consistent with chat.md (3 formats tested)
- [x] **Search messages**: grep-style search of chat.md content works
- [x] **List rooms**: Scans data/rooms/ directory, returns all rooms
- [x] **Export room**: Both markdown and JSON formats work
- [x] **Pin message**: chat.md correctly adds pinned marker, multiple pins coexist
- [x] **Poll new messages**: Returns unread messages based on cursor, advances cursor
- [x] **Relay file_ref**: Codex uses room directory as cwd, reads chat.md directly (after BUG-001 fix)
- [x] **Relay inline**: Context inlined in prompt, within ~4000 token budget
- [x] **Response auto-storage**: Relay responses auto-appended to chat.md
- [x] **Migration data integrity**: Message count, participants, metadata match SQLite original
- [x] **Discussion continuation**: Successfully continued multi-AI discussion on new architecture

---

*Report generated by Claude Opus 4.6 on 2026-03-19.*
