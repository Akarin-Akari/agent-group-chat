/**
 * CLI Relay — One-shot CLI spawns for Codex & Gemini.
 *
 * Architecture (pivot from persistent sessions):
 *   Both Codex CLI and Gemini CLI are designed for one-shot pipe mode:
 *     echo "prompt" | codex exec --sandbox read-only
 *     echo "prompt" | gemini
 *   They do NOT support persistent interactive sessions via piped stdio
 *   (they require a real TTY for interactive mode).
 *
 *   Therefore each relay call:
 *     1. Spawns a fresh child process
 *     2. Writes the prompt to stdin, then closes stdin
 *     3. Collects stdout + stderr until process exits
 *     4. Extracts the response from the collected output
 *     5. Process exits naturally after responding
 *
 *   Trade-off: Codex loads MCP servers on every spawn (~30-120s with --sandbox read-only).
 *   This is acceptable because:
 *     a) Each relay is independent and self-contained
 *     b) --sandbox read-only skips some MCP overhead
 *     c) The alternative (persistent sessions) doesn't work with pipe stdio
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

// ─── Types ────────────────────────────────────────────────���─────────────────

interface CliConfig {
  /** CLI command */
  command: string;
  /** CLI arguments for one-shot pipe mode */
  args: string[];
  /** Which stream carries the main response */
  responseFrom: 'stdout' | 'stderr';
  /** Extract the actual response text from raw collected output */
  extractResponse: (stdout: string, stderr: string) => string;
  /** Max wait for the entire spawn-to-exit cycle */
  timeoutMs: number;
  /**
   * Extra environment variables to inject into the spawned process.
   * Merged on top of `process.env` — use this to redirect config directories
   * (e.g. CODEX_HOME) so the CLI loads a minimal config without MCP servers.
   */
  env?: Record<string, string>;
}

// ─── Response Extractors ────────────────────────────────────────────────────

/**
 * Codex CLI writes ALL output to stderr in this structure:
 *   ... MCP startup logs ...
 *   thinking
 *   <thinking content>
 *   codex
 *   <ACTUAL RESPONSE>
 *   tokens used
 *   <count>
 *
 * stdout may also contain the final response (duplicated).
 */
function extractCodexResponse(stdout: string, stderr: string): string {
  // Try stderr first (primary output channel for Codex)
  const raw = stderr;
  const lines = raw.split('\n');
  let responseStart = -1;
  let responseEnd = -1;

  // Scan backwards: find "tokens used" then the preceding "codex" marker
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed === 'tokens used' && responseEnd === -1) {
      responseEnd = i;
    }
    if (trimmed === 'codex' && responseEnd > i && responseStart === -1) {
      responseStart = i + 1;
      break;
    }
  }

  if (responseStart > 0 && responseEnd > responseStart) {
    return lines.slice(responseStart, responseEnd).join('\n').trim();
  }

  // Fallback: grab everything after the last "codex\n" marker
  const lastMarker = raw.lastIndexOf('\ncodex\n');
  if (lastMarker >= 0) {
    let content = raw.substring(lastMarker + '\ncodex\n'.length);
    const tokensIdx = content.indexOf('\ntokens used\n');
    if (tokensIdx >= 0) content = content.substring(0, tokensIdx);
    if (content.trim().length > 10) return content.trim();
  }

  // Try stdout (Codex sometimes duplicates the response there)
  if (stdout.trim().length > 10) {
    // stdout usually has just the clean response
    return stdout.trim();
  }

  // Last resort: strip known noise patterns from stderr
  const cleaned = raw
    .replace(/^Reading prompt from stdin\.\.\.$/m, '')
    .replace(/^OpenAI Codex v[\s\S]*?--------\n/m, '')
    .replace(/^user$/m, '')
    .replace(/^thinking\n[\s\S]*?(?=\ncodex\n)/m, '')
    .replace(/^codex$/m, '')
    .replace(/\ntokens used\n[\s\S]*$/m, '')
    .replace(/^mcp:.*$/gm, '')
    .replace(/^mcp startup:.*$/gm, '')
    .replace(/^warning:.*$/gm, '')
    .replace(/^Reconnecting\.\.\. .*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned || raw.trim();
}

/**
 * Gemini CLI writes the response to stdout.
 * stderr contains import errors and other noise.
 */
function extractGeminiResponse(stdout: string, _stderr: string): string {
  // Remove ANSI escape codes
  let clean = stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  // Remove common prompt indicators
  clean = clean.replace(/^[╰└>❯→$]\s*$/gm, '');
  // Remove spinner/progress indicators
  clean = clean.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏].*$/gm, '');
  return clean.trim();
}

// ─── Codex Minimal Config (CODEX_HOME override) ─────────────────────────────

/**
 * Codex CLI loads 30+ MCP servers from ~/.codex/config.toml on every spawn,
 * causing ~30-120s startup delay and ~31k tokens wasted per call.
 *
 * Solution: Set CODEX_HOME to a minimal config directory that contains:
 *   - config.toml  (model settings, features — NO mcp_servers section)
 *   - auth.json    (copied from ~/.codex/auth.json for API authentication)
 *
 * This reduces startup to <5s and token usage from ~31k to ~12.7k (60% saving).
 * The original ~/.codex/config.toml is untouched — standalone Codex usage is not affected.
 */
const CODEX_MINIMAL_HOME = path.join(
  process.env.TEMP || process.env.TMP || '/tmp',
  'codex-group-chat',
);

/**
 * Ensure the minimal Codex config directory exists with config.toml and auth.json.
 * Called once at module load time.
 */
function ensureCodexMinimalHome(): void {
  try {
    fs.mkdirSync(CODEX_MINIMAL_HOME, { recursive: true });

    // ── config.toml (minimal — no mcp_servers) ────────────────────────────
    const configPath = path.join(CODEX_MINIMAL_HOME, 'config.toml');
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(
        configPath,
        [
          '# Minimal Codex config for group-chat relay calls (no MCP servers)',
          'model = "gpt-5.3-codex"',
          'model_reasoning_effort = "xhigh"',
          'windows_wsl_setup_acknowledged = true',
          'personality = "pragmatic"',
          '',
          '[features]',
          'experimental_windows_sandbox = true',
          'unified_exec = true',
          'shell_snapshot = true',
          'powershell_utf8 = true',
          'steer = true',
          '',
        ].join('\n'),
        'utf-8',
      );
      console.error(`[cli-relay] 📝 Created minimal config.toml at ${configPath}`);
    }

    // ── auth.json (copy from ~/.codex/auth.json) ──────────────────────────
    const authDst = path.join(CODEX_MINIMAL_HOME, 'auth.json');
    if (!fs.existsSync(authDst)) {
      const home = process.env.USERPROFILE || process.env.HOME || '';
      const authSrc = path.join(home, '.codex', 'auth.json');
      if (fs.existsSync(authSrc)) {
        fs.copyFileSync(authSrc, authDst);
        console.error(`[cli-relay] 🔑 Copied auth.json from ${authSrc}`);
      } else {
        console.error(
          `[cli-relay] ⚠️ auth.json not found at ${authSrc} — Codex may fail with 401`,
        );
      }
    }
  } catch (err: any) {
    console.error(`[cli-relay] ⚠️ Failed to set up CODEX_HOME: ${err.message}`);
  }
}

// Initialize on module load
ensureCodexMinimalHome();

// ─── CLI Configs ────────────────────────────────────────────────────────────

const CLI_CONFIGS: Record<string, CliConfig> = {
  codex: {
    command: 'codex',
    args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check'],
    responseFrom: 'stderr',
    extractResponse: extractCodexResponse,
    timeoutMs: 300_000, // 5 min max per call
    env: { CODEX_HOME: CODEX_MINIMAL_HOME },
  },
  gemini: {
    command: 'gemini',
    args: [],
    responseFrom: 'stdout',
    extractResponse: extractGeminiResponse,
    timeoutMs: 300_000, // 5 min max (Gemini may use deep thinking + web search)
  },
};

// ─── One-Shot Spawn ─────────────────────────────────────────────────────────

/**
 * Spawn a CLI process, pipe the prompt via stdin, collect output, return response.
 * The process exits naturally after producing its response.
 */
function runCli(target: string, prompt: string, cwd?: string): Promise<string> {
  const config = CLI_CONFIGS[target];
  if (!config) {
    return Promise.reject(
      new Error(`Unknown target: ${target}. Supported: ${Object.keys(CLI_CONFIGS).join(', ')}`),
    );
  }

  return new Promise<string>((resolve, reject) => {
    const { command, args, extractResponse, timeoutMs, env: targetEnv } = config;

    console.error(
      `[cli-relay] ⏳ Spawning ${target}: ${command} ${args.join(' ')} (prompt: ${prompt.length} chars)`,
    );
    const startTime = Date.now();

    let stdout = '';
    let stderr = '';
    let settled = false;

    const proc = spawn(command, args, {
      shell: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...targetEnv },
      cwd: cwd || process.env.USERPROFILE || process.env.HOME || undefined,
    });

    // Collect stdout
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });

    // Collect stderr
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    // Timeout guard
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.error(`[cli-relay] ⏰ ${target} timed out after ${elapsed}s`);

        // Try to extract whatever we have
        const partial = extractResponse(stdout, stderr);
        if (partial.length > 30) {
          console.error(`[cli-relay] ⚠️ Returning partial response (${partial.length} chars)`);
          resolve(partial);
        } else {
          reject(new Error(`${target} timed out after ${timeoutMs / 1000}s`));
        }

        try {
          proc.kill();
        } catch {}
      }
    }, timeoutMs);

    // Process exit
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.error(
        `[cli-relay] ${code === 0 ? '✅' : '⚠️'} ${target} exited: code=${code}, elapsed=${elapsed}s, stdout=${stdout.length}B, stderr=${stderr.length}B`,
      );

      // Even with non-zero exit codes, try to extract a response
      // (Codex sometimes exits with code 1 but has a valid response in stderr)
      const response = extractResponse(stdout, stderr);

      if (response.length > 10) {
        resolve(response);
      } else if (code !== 0) {
        // Include some stderr context in the error
        const stderrSnippet = stderr.trim().slice(-500);
        reject(
          new Error(
            `${target} exited with code ${code}. Last stderr: ${stderrSnippet || '(empty)'}`,
          ),
        );
      } else {
        // Exit 0 but empty response — unusual
        resolve(response || '(empty response)');
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new Error(`Failed to spawn ${target}: ${err.message}`));
    });

    // Write the prompt to stdin and close it (signals "end of input" to the CLI)
    proc.stdin?.write(prompt, 'utf-8');
    proc.stdin?.end();
  });
}

// ─── CliSessionPool (API-compatible wrapper) ────────────────────────────────

/**
 * Provides the same API as the old persistent session pool,
 * but internally uses one-shot spawns for each relay call.
 *
 * Kept as a singleton for API compatibility with relay-message.ts and warm-session.ts.
 */
export class CliSessionPool {
  private static instance: CliSessionPool;

  static getInstance(): CliSessionPool {
    if (!CliSessionPool.instance) {
      CliSessionPool.instance = new CliSessionPool();
    }
    return CliSessionPool.instance;
  }

  /**
   * Send a prompt to the target CLI via one-shot spawn.
   * Each call spawns a fresh process that exits after responding.
   */
  async relay(target: string, prompt: string, cwd?: string): Promise<string> {
    return runCli(target, prompt, cwd);
  }

  /**
   * "Warm up" a target — in one-shot mode, this just verifies
   * that the CLI is accessible by running a quick ping.
   */
  async warmUp(target: string): Promise<{ status: string; elapsedMs: number }> {
    const config = CLI_CONFIGS[target];
    if (!config) {
      throw new Error(
        `Unknown target: ${target}. Supported: ${Object.keys(CLI_CONFIGS).join(', ')}`,
      );
    }

    const start = Date.now();

    try {
      // Quick connectivity test: send a trivial prompt
      const response = await runCli(target, 'Reply with only the word "ready". Nothing else.');
      const elapsedMs = Date.now() - start;
      console.error(
        `[cli-relay] 🔥 ${target} warm-up complete: ${elapsedMs}ms, response: "${response.slice(0, 50)}"`,
      );
      return { status: 'warmed_up', elapsedMs };
    } catch (err: any) {
      throw new Error(`${target} warm-up failed: ${err.message}`);
    }
  }

  /**
   * Get status of all targets (no persistent state in one-shot mode).
   */
  getStatus(): Record<string, { status: string; alive: boolean }> {
    const result: Record<string, { status: string; alive: boolean }> = {};
    for (const target of Object.keys(CLI_CONFIGS)) {
      result[target] = { status: 'idle', alive: true };
    }
    return result;
  }

  /**
   * No-op in one-shot mode (no persistent processes to destroy).
   */
  destroySession(_target: string): void {}

  /**
   * No-op in one-shot mode.
   */
  destroyAll(): void {}

  /**
   * Get list of supported targets.
   */
  static getSupportedTargets(): string[] {
    return Object.keys(CLI_CONFIGS);
  }
}
