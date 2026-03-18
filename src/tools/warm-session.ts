import { ToolDefinition, ToolHandler } from '../types/index.js';
import { CliSessionPool } from '../cli-session-pool.js';

/**
 * warm_session — Pre-start CLI processes so subsequent relay calls are instant.
 *
 * Codex CLI loads 30+ MCP servers on startup (~3-5 min).
 * Gemini CLI also has startup overhead (~1-2 min).
 * By warming up sessions in advance, the first relay_message call
 * doesn't need to wait for this startup cost.
 *
 * Supports parallel warm-up: target="all" launches all CLI processes
 * concurrently via Promise.allSettled, so wall-clock time ≈ max(individual).
 */

const supportedTargets = CliSessionPool.getSupportedTargets();

export const toolDefinition: ToolDefinition = {
  name: 'warm_session',
  description:
    'Pre-start CLI sessions so that subsequent relay_message calls are fast. ' +
    'Codex CLI loads 30+ MCP servers on startup (~3-5 min). ' +
    'Call this tool early to pay that cost upfront. ' +
    'Use target="all" to warm up ALL supported targets in parallel (recommended). ' +
    'If sessions are already warm, returns immediately.',
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: [...supportedTargets, 'all'],
        description:
          'Target AI to warm up. Use "all" to warm up every supported target in parallel. ' +
          `Supported individual targets: ${supportedTargets.join(', ')}`,
      },
    },
    required: ['target'],
  },
};

// ─── Single-target warm-up ─────────────────────────────────────────────────

interface SingleWarmResult {
  target: string;
  status: string;
  elapsed_ms: number;
  error?: string;
}

async function warmSingle(
  pool: CliSessionPool,
  target: string,
): Promise<SingleWarmResult> {
  try {
    const result = await pool.warmUp(target);
    return {
      target,
      status: result.status,
      elapsed_ms: result.elapsedMs,
    };
  } catch (err: any) {
    return {
      target,
      status: 'failed',
      elapsed_ms: 0,
      error: err.message,
    };
  }
}

// ─── Handler ───────────────────────────────────────────────────────────────

export const toolHandler: ToolHandler = async (invocation) => {
  const { target } = invocation.input as { target: string };
  const pool = CliSessionPool.getInstance();

  // ── Parallel warm-up: target = "all" ──────────────────────────────────

  if (target === 'all') {
    const targets = CliSessionPool.getSupportedTargets();
    console.error(
      `[group-chat] 🔥 Parallel warm-up: starting ${targets.length} sessions (${targets.join(', ')})...`,
    );

    const wallClockStart = Date.now();

    // Launch all warm-ups concurrently — Promise.allSettled guarantees
    // one failure doesn't abort the others (critical for partial success)
    const settled = await Promise.allSettled(
      targets.map((t) => warmSingle(pool, t)),
    );

    const wallClockMs = Date.now() - wallClockStart;
    const wallClockSec = (wallClockMs / 1000).toFixed(1);

    // Collect per-target results
    const results: Record<string, SingleWarmResult> = {};
    const statusParts: string[] = [];
    let allSuccess = true;

    for (const outcome of settled) {
      // Promise.allSettled with our warmSingle wrapper should always fulfill
      // (errors are caught inside warmSingle), but handle rejection defensively
      if (outcome.status === 'fulfilled') {
        const r = outcome.value;
        results[r.target] = r;

        if (r.status === 'failed') {
          allSuccess = false;
          statusParts.push(`${r.target} ❌ (${r.error})`);
        } else if (r.status === 'already_ready') {
          statusParts.push(`${r.target} ✅ (already warm)`);
        } else {
          const sec = (r.elapsed_ms / 1000).toFixed(1);
          statusParts.push(`${r.target} ✅ (${sec}s)`);
        }
      } else {
        // Defensive: shouldn't happen due to warmSingle's catch, but just in case
        allSuccess = false;
        const reason = (outcome as PromiseRejectedResult).reason;
        const errMsg = reason?.message || String(reason);
        statusParts.push(`unknown ❌ (${errMsg})`);
      }
    }

    const summaryIcon = allSuccess ? '🔥' : '⚠️';
    const summaryText = allSuccess
      ? `All ${targets.length} sessions warmed up in ${wallClockSec}s (wall-clock).`
      : `Partial warm-up in ${wallClockSec}s — some targets failed.`;

    return {
      message:
        `${summaryIcon} Parallel warm-up complete: ${statusParts.join(', ')}\n` +
        `${summaryText}\n` +
        `Subsequent relay_message calls will be fast for warm targets.`,
      data: {
        mode: 'parallel',
        results,
        all_success: allSuccess,
        wall_clock_ms: wallClockMs,
        wall_clock_seconds: parseFloat(wallClockSec),
      },
    };
  }

  // ── Single-target warm-up ─────────────────────────────────────────────

  if (!supportedTargets.includes(target)) {
    return {
      message: `❌ Unsupported target: "${target}". Supported: ${supportedTargets.join(', ')}, all`,
      data: { error: 'unsupported_target' },
    };
  }

  console.error(`[group-chat] 🔥 Warming up ${target} session...`);

  const result = await warmSingle(pool, target);

  if (result.error) {
    return {
      message: `❌ Failed to warm up ${target}: ${result.error}`,
      data: { error: 'warmup_failed', target, details: result.error },
    };
  }

  if (result.status === 'already_ready') {
    return {
      message: `✅ ${target} session is already warm and ready for relay_message calls.`,
      data: { mode: 'single', target, status: 'already_ready', elapsed_ms: 0 },
    };
  }

  const elapsedSec = (result.elapsed_ms / 1000).toFixed(1);
  return {
    message:
      `🔥 ${target} session warmed up in ${elapsedSec}s. ` +
      `Subsequent relay_message calls will be fast.`,
    data: {
      mode: 'single',
      target,
      status: result.status,
      elapsed_ms: result.elapsed_ms,
      elapsed_seconds: parseFloat(elapsedSec),
    },
  };
};
