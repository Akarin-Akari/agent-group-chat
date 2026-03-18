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
