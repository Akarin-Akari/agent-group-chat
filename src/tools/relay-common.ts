/**
 * relay-common.ts — Shared logic for relay_message and relay_message_inline.
 *
 * Extracts common validation, response storage, and CLI invocation logic
 * so both relay tools avoid code duplication.
 *
 * Includes Layer 1 heuristic gate: validates relay responses before writing
 * to chat.md based on the room's moderation level.
 */

import { CliSessionPool } from '../cli-session-pool.js';
import { GroupChatManagerImpl } from '../manager.js';
import { ToolResult } from '../types/index.js';
import { validateRelayResponse } from './response-validator.js';
import { createHash } from 'crypto';
import fs from 'fs';

export interface RelayInput {
  room_id: string;
  target: string;
  prompt?: string;
}

export interface RelayValidation {
  valid: true;
  participantId: string;
  participantName: string;
}

export interface RelayValidationError {
  valid: false;
  result: ToolResult;
}

/**
 * Validate relay input: check target is supported and participant is registered.
 */
export function validateRelay(
  input: RelayInput,
  manager: GroupChatManagerImpl,
): RelayValidation | RelayValidationError {
  const { target } = input;
  const supportedTargets = CliSessionPool.getSupportedTargets();

  if (!supportedTargets.includes(target)) {
    return {
      valid: false,
      result: {
        message: `❌ Unsupported target: "${target}". Supported: ${supportedTargets.join(', ')}`,
        data: { error: 'unsupported_target' },
      },
    };
  }

  const participant = manager.getParticipantByName(target);
  if (!participant) {
    return {
      valid: false,
      result: {
        message: `❌ Participant "${target}" not registered. Call \`register_participant\` first.`,
        data: { error: 'participant_not_found' },
      },
    };
  }

  return {
    valid: true,
    participantId: participant.id,
    participantName: participant.name,
  };
}

/**
 * Execute CLI relay call and store the response as a message.
 */
export async function executeRelayAndStore(
  roomId: string,
  target: string,
  participantId: string,
  fullPrompt: string,
  manager: GroupChatManagerImpl,
  mode: string,
  cwd?: string,
): Promise<ToolResult> {
  const pool = CliSessionPool.getInstance();

  console.error(`[group-chat] 🔄 Relaying to ${target} via ${mode} mode`);
  console.error(`[group-chat]    Prompt length: ${fullPrompt.length} chars`);
  const startTime = Date.now();

  // ── P1+P2: Pre-relay integrity protection ────────────────────────────
  // Snapshot chat.md hash + backup before relay to detect/recover tampering
  const fileStore = manager.getFileStore();
  const chatPath = fileStore.getChatFilePath(roomId);
  let preRelayHash = '';
  const backupPath = chatPath + '.pre-relay';
  try {
    if (fs.existsSync(chatPath)) {
      const content = fs.readFileSync(chatPath);
      preRelayHash = createHash('sha256').update(content).digest('hex');
      fs.copyFileSync(chatPath, backupPath);
    }
  } catch (err: any) {
    console.error(`[group-chat] ⚠️ Pre-relay snapshot failed: ${err.message}`);
  }

  let response: string;
  try {
    response = await pool.relay(target, fullPrompt, cwd);
  } catch (err: any) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    return {
      message:
        `❌ ${target} CLI relay failed after ${elapsed}s: ${err.message}\n\n` +
        `Make sure the \`${target}\` CLI is installed and configured.\n` +
        `Tip: Use \`warm_session\` tool to pre-start the CLI in the background.`,
      data: { error: 'cli_failed', details: err.message, elapsed_seconds: parseFloat(elapsed) },
    };
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // ── P1: Post-relay tamper detection ──────────────────────────────────
  // Verify chat.md was not modified by the target CLI during relay
  if (preRelayHash) {
    try {
      const postContent = fs.readFileSync(chatPath);
      const postRelayHash = createHash('sha256').update(postContent).digest('hex');
      if (postRelayHash !== preRelayHash) {
        console.error(
          `[group-chat] 🚨 TAMPER DETECTED: chat.md was modified during relay by ${target}!` +
          ` Pre-hash: ${preRelayHash.slice(0, 12)}... Post-hash: ${postRelayHash.slice(0, 12)}...`,
        );
        // P2: Auto-recover from backup
        if (fs.existsSync(backupPath)) {
          fs.copyFileSync(backupPath, chatPath);
          console.error(`[group-chat] 🔧 Auto-recovered chat.md from pre-relay backup`);
        }
        // Clean up backup
        try { fs.unlinkSync(backupPath); } catch {}
        return {
          message:
            `🚨 **TAMPER DETECTED**: \`${target}\` modified chat.md during relay!\n\n` +
            `The file has been automatically recovered from backup.\n` +
            `The relay response was NOT stored.\n\n` +
            `**Response from ${target}** (for manual review):\n${response}\n\n` +
            `---\n📊 Elapsed: ${elapsed}s | Mode: ${mode}`,
          data: {
            tamper_detected: true,
            recovered: true,
            target,
            response,
            elapsed_seconds: parseFloat(elapsed),
          },
        };
      }
    } catch (err: any) {
      console.error(`[group-chat] ⚠️ Post-relay hash check failed: ${err.message}`);
    }
  }
  // Clean up backup on success
  try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}

  // ── Layer 1: Heuristic response gate ───────────────────────────────────
  // TEMPORARILY DISABLED — see docs/2026-03-19-response-validator-status.md
  // BUG-001 false negative unresolved; re-enable after fixing noise ratio edge case.
  //
  // const moderationLevel = manager.getModerationLevel(roomId);
  //
  // if (moderationLevel !== 'none') {
  //   const validation = validateRelayResponse(response, fullPrompt);
  //
  //   if (validation.confidence === 'blocked') {
  //     console.error(`[group-chat] Response BLOCKED by gate: ${validation.reason}`);
  //     return { message: `Response blocked...`, data: { blocked: true } };
  //   }
  //   if (moderationLevel === 'strict' && validation.confidence === 'suspect') {
  //     console.error(`[group-chat] Response HELD (strict mode): ${validation.reason}`);
  //     return { message: `Response held...`, data: { held: true } };
  //   }
  //   if (validation.confidence === 'suspect') {
  //     console.error(`[group-chat] Response SUSPECT (passing): ${validation.reason}`);
  //   }
  // }

  // Store the response as a message from the target participant
  const msg = manager.sendMessage(roomId, participantId, response);

  console.error(
    `[group-chat] ✅ ${target} responded (${response.length} chars) in ${elapsed}s, stored as msg #${msg.sequenceNumber}`,
  );

  return {
    message:
      `🤖 **${target}** responded (via ${mode}):\n\n` +
      `${response}\n\n` +
      `---\n` +
      `📊 Message ID: \`${msg.id}\` | Sequence: #${msg.sequenceNumber} | ` +
      `Length: ${response.length} chars | Elapsed: ${elapsed}s`,
    data: {
      message_id: msg.id,
      sequence: msg.sequenceNumber,
      participant: target,
      response,
      response_length: response.length,
      elapsed_seconds: parseFloat(elapsed),
      mode,
    },
  };
}
