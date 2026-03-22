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

import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Maximum bytes to accumulate from stdout/stderr per CLI spawn.
 * Prevents unbounded memory growth when CLI produces excessive output
 * (e.g., Gemini scanning home directory, Codex loading 30+ MCP servers).
 */
const MAX_BUFFER_BYTES = 5 * 1024 * 1024; // 5 MB

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

    // ── Detect model from main Codex config ──────────────────────────────
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const mainConfigPath = path.join(home, '.codex', 'config.toml');
    let model = 'o3';  // safe default
    try {
      if (fs.existsSync(mainConfigPath)) {
        const mainConfig = fs.readFileSync(mainConfigPath, 'utf-8');
        const match = mainConfig.match(/^model\s*=\s*"([^"]+)"/m);
        if (match) model = match[1];
      }
    } catch {}

    // ── config.toml (always rewrite to keep model in sync) ──────────────
    const configPath = path.join(CODEX_MINIMAL_HOME, 'config.toml');
    fs.writeFileSync(
      configPath,
      [
        '# Minimal Codex config for group-chat relay calls (no MCP servers)',
        `model = "${model}"`,
        'model_reasoning_effort = "high"',
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
    console.error(`[cli-relay] 📝 Codex minimal config: model=${model} at ${configPath}`);

    // ── auth.json (copy from ~/.codex/auth.json) ──────────────────────────
    const authDst = path.join(CODEX_MINIMAL_HOME, 'auth.json');
    if (!fs.existsSync(authDst)) {
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

// ─── Gemini Model Detection ──────────────────────────────────────────────────

/**
 * Read the user's preferred Gemini model from ~/.gemini/settings.json.
 * Never writes to the file — read-only detection.
 */
function detectGeminiModel(): string {
  const defaultModel = 'gemini-2.5-pro';
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const settingsPath = path.join(home, '.gemini', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const model = settings?.model?.name;
      if (model) {
        console.error(`[cli-relay] 🔍 Detected Gemini model from settings: ${model}`);
        return model;
      }
    }
  } catch {}
  console.error(`[cli-relay] 🔍 Using default Gemini model: ${defaultModel}`);
  return defaultModel;
}

const GEMINI_MODEL = detectGeminiModel();

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
    args: ['--model', GEMINI_MODEL, '--approval-mode', 'plan'],
    responseFrom: 'stdout',
    extractResponse: extractGeminiResponse,
    timeoutMs: 300_000, // 5 min max (Gemini may use deep thinking + web search)
  },
};

// ─── Process Cleanup ─────────────────────────────────────────────────────────

/**
 * Kill a process and its entire child tree.
 *
 * On Windows, `proc.kill()` only kills the immediate process (cmd.exe shell),
 * leaving the actual CLI child process alive as a zombie. We use `taskkill /T`
 * to kill the entire tree. On Unix, SIGTERM propagates naturally.
 */
function killProcessTree(pid: number | undefined): void {
  if (!pid) return;

  try {
    if (process.platform === 'win32') {
      // /F = force, /T = tree (kill child processes), /PID = target
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 5000 });
      console.error(`[cli-relay] 🔪 Killed process tree (PID ${pid})`);
    } else {
      process.kill(-pid, 'SIGTERM'); // Negative PID = process group
      console.error(`[cli-relay] 🔪 Killed process group (PID ${pid})`);
    }
  } catch {
    // Process may have already exited — ignore
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already dead
    }
  }
}

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
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const effectiveCwd = cwd || process.env.USERPROFILE || process.env.HOME || undefined;

    // Warn if cwd looks like home directory or MCP server directory (likely misconfigured)
    if (effectiveCwd) {
      const home = process.env.USERPROFILE || process.env.HOME || '';
      const serverDir = path.resolve(__dirname, '..');
      if (effectiveCwd === home) {
        console.error(
          `[cli-relay] ⚠️ cwd is user home directory (${effectiveCwd}). ` +
          `Target AI will scan the entire home dir. Consider passing a project-specific cwd via the relay tool's cwd parameter.`,
        );
      } else if (effectiveCwd === serverDir) {
        console.error(
          `[cli-relay] ⚠️ cwd is MCP server directory (${effectiveCwd}). ` +
          `Target AI will see group-chat source, not user's project. Consider passing the project cwd via the relay tool's cwd parameter.`,
        );
      }
    }

    const proc = spawn(command, args, {
      shell: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...targetEnv },
      cwd: effectiveCwd,
    });

    // Collect stdout (capped at MAX_BUFFER_BYTES)
    proc.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes < MAX_BUFFER_BYTES) {
        const str = chunk.toString('utf-8');
        stdout += str;
        stdoutBytes += chunk.length;
      }
    });

    // Collect stderr (capped at MAX_BUFFER_BYTES)
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < MAX_BUFFER_BYTES) {
        const str = chunk.toString('utf-8');
        stderr += str;
        stderrBytes += chunk.length;
      }
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

        // Clean up: remove stream listeners to stop memory accumulation
        proc.stdout?.removeAllListeners('data');
        proc.stderr?.removeAllListeners('data');

        // Kill the process tree (shell: true spawns via cmd.exe on Windows)
        killProcessTree(proc.pid);
      }
    }, timeoutMs);

    // Process exit
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      // Clean up stream listeners
      proc.stdout?.removeAllListeners('data');
      proc.stderr?.removeAllListeners('data');

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
