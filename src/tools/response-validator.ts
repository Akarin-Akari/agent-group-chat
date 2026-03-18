/**
 * response-validator.ts — Layer 1: Heuristic response gate for relay messages.
 *
 * Validates relay responses BEFORE they are written to chat.md.
 * Zero cost, zero latency, zero external dependencies.
 *
 * Design principles:
 *   1. "Noise Ratio" over "Keyword Matching"
 *      — Detects how much of the response is CLI garbage, not whether it contains any.
 *   2. "Markdown-Aware"
 *      — Content inside ```code blocks``` and > quote blocks is EXCLUDED from
 *        noise detection. Deliberately formatted content ≠ CLI leakage.
 *   3. "Positive Signal Immunity"
 *      — Responses with enough analytical structure (headings, lists, paragraphs)
 *        pass even if noise ratio is moderate (e.g., bug analysis citing logs).
 *
 * Catches:
 *   Type 1 — Structural garbage (raw CLI output dominating the response)
 *   Type 2 — Empty/invalid/parrot responses
 *
 * Does NOT catch (by design — left to orchestrator):
 *   Type 3 — Semantically irrelevant but syntactically valid text
 *   Type 4 — Low-quality but topically relevant responses
 */

export type ValidationConfidence = 'blocked' | 'suspect' | 'passed';

export interface ValidationResult {
  confidence: ValidationConfidence;
  reason?: string;
  /** First 200 chars of raw response (for orchestrator debugging) */
  rawSnippet?: string;
}

// ─── Noise patterns (CLI leakage signatures) ────────────────────────────────

const NOISE_LINE_PATTERNS: RegExp[] = [
  /^exec\s*$/,                                // Codex tool-use exec marker
  /exited \d+ in [\d.]+s/,                    // "exited 1 in 25.62s"
  /succeeded in [\d.]+s/,                      // "succeeded in 18.29s"
  /^"[A-Z]:\\.*\\pwsh\.exe"\s+-Command/,       // PowerShell command invocation
  /^"[A-Z]:\\.*\\cmd\.exe"/,                   // cmd.exe invocation
  /^\s*Get-ChildItem\b/,                       // PowerShell cmdlet
  /^\s*Get-Location\b/,                        // PowerShell cmdlet
  /^\s*Select-Object\b/,                       // PowerShell cmdlet
  /^\s*rg --files/,                            // ripgrep file search
  /ErrorAction SilentlyContinue/,              // PowerShell error handling
  /^mcp:/,                                     // MCP log line
  /^mcp startup:/,                             // MCP startup log
  /^Reconnecting\.\.\./,                       // MCP reconnection
  /^warning: .* MCP server/,                   // MCP server warning
  /^Reading prompt from stdin/,                // Codex stdin marker
  /^OpenAI Codex v/,                           // Codex version banner
  /^tokens used$/,                             // Codex token counter
  /^thinking$/,                                // Codex thinking marker
  /^codex$/,                                   // Codex response marker
  /版本管理器已加载/,                            // fnm/pyenv loader noise
  /^-{4,}$/,                                   // PowerShell table separator
  /^Path\s*$/,                                 // PowerShell Get-Location header
  /^[A-Z]:\\[\w\\]+$/,                          // Bare Windows path (e.g. C:\Users\Akari)
  /^__\w+__$/,                                 // __pycache__ style directory name
  /^\.\w[\w.-]*$/,                             // Bare dotfile/dotdir name (.ace-tool, .agent)
];

// ─── Positive signal patterns (analytical structure) ─────────────────────────

const POSITIVE_LINE_PATTERNS: RegExp[] = [
  /^#{1,6}\s+.+/,                              // Markdown headings
  /^\*\*.+\*\*/,                               // Bold text (emphasis)
  /^[-*]\s+.+/,                                // Unordered list items
  /^\d+\.\s+.+/,                               // Ordered list items
  /^>\s+.+/,                                   // Quote blocks (also a positive: intentional formatting)
  /\[.+\]\(.+\)/,                              // Markdown links
  /^```/,                                      // Code block delimiters (intentional formatting)
  /^\|.+\|/,                                   // Markdown table rows
];

// ─── Core validation logic ──────────────────────────────────────────────────

/**
 * Validate a relay response before writing to chat.md.
 *
 * Uses noise-ratio analysis with markdown-aware exclusion zones
 * and positive-signal immunity to avoid false positives on code discussions.
 */
export function validateRelayResponse(
  response: string,
  prompt?: string,
): ValidationResult {
  // Strip ANSI escape codes
  const clean = response.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
  const snippet = clean.slice(0, 200);

  // ── Type 2: Empty / trivial ──────────────────────────────────────────
  if (clean.length === 0) {
    return { confidence: 'blocked', reason: 'Empty response', rawSnippet: '(empty)' };
  }

  if (clean.length < 2) {
    return { confidence: 'blocked', reason: `Near-empty response (${clean.length} chars)`, rawSnippet: snippet };
  }

  if (clean === '(empty response)' || clean === 'ready') {
    return { confidence: 'blocked', reason: `Trivial response: "${clean}"`, rawSnippet: snippet };
  }

  // ── Type 1: Parrot detection ─────────────────────────────────────────
  if (prompt && prompt.length > 50) {
    const overlapRatio = computeOverlapRatio(clean, prompt);
    if (overlapRatio > 0.8) {
      return {
        confidence: 'blocked',
        reason: `Parrot response (${Math.round(overlapRatio * 100)}% overlap with prompt)`,
        rawSnippet: snippet,
      };
    }
  }

  // ── Markdown-aware line analysis ─────────────────────────────────────
  const lines = clean.split('\n');
  const analysis = analyzeLines(lines);

  // ── Type 1: Noise ratio decision ─────────────────────────────────────
  // Only consider exposed (non-protected) lines for noise ratio
  const exposedTotal = analysis.exposedLines;
  const noiseRatio = exposedTotal > 0 ? analysis.noiseLines / exposedTotal : 0;

  if (noiseRatio > 0.7 && analysis.positiveSignals < 2) {
    return {
      confidence: 'blocked',
      reason: `Response is predominantly CLI output (noise: ${Math.round(noiseRatio * 100)}% of ${exposedTotal} exposed lines, positive signals: ${analysis.positiveSignals})`,
      rawSnippet: snippet,
    };
  }

  if (noiseRatio > 0.4 && analysis.positiveSignals < 2) {
    return {
      confidence: 'suspect',
      reason: `High noise ratio (${Math.round(noiseRatio * 100)}% of exposed lines, positive signals: ${analysis.positiveSignals})`,
      rawSnippet: snippet,
    };
  }

  // ── Soft warning: very short ─────────────────────────────────────────
  if (clean.length < 50) {
    return {
      confidence: 'suspect',
      reason: `Very short response (${clean.length} chars)`,
      rawSnippet: snippet,
    };
  }

  // ── Passed ───────────────────────────────────────────────────────────
  return { confidence: 'passed' };
}

// ─── Line analysis engine ───────────────────────────────────────────────────

interface LineAnalysis {
  /** Number of lines outside markdown protection zones */
  exposedLines: number;
  /** Number of exposed lines matching noise patterns */
  noiseLines: number;
  /** Count of positive analytical signals across entire response */
  positiveSignals: number;
  /** Total non-empty lines */
  totalLines: number;
}

/**
 * Analyze response lines with markdown-aware noise detection.
 *
 * Lines inside ```code blocks``` are considered "protected" and excluded
 * from noise detection. They DO count as positive signals (intentional formatting).
 */
function analyzeLines(lines: string[]): LineAnalysis {
  let inCodeBlock = false;
  let exposedLines = 0;
  let noiseLines = 0;
  let positiveSignals = 0;
  let consecutiveCleanText = 0;
  let totalNonEmpty = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (trimmed.length === 0) {
      consecutiveCleanText = 0;
      continue;
    }

    totalNonEmpty++;

    // Track code block boundaries
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      positiveSignals++; // Code block delimiter = intentional formatting
      continue;
    }

    // Inside code block: protected zone (not counted as noise)
    if (inCodeBlock) {
      // Code blocks themselves are positive signals (already counted above)
      continue;
    }

    // Check for positive signals (across all exposed lines)
    if (POSITIVE_LINE_PATTERNS.some(p => p.test(trimmed))) {
      positiveSignals++;
    }

    // Check for substantial text content (CJK or multi-word English)
    // CJK threshold: high density AND sufficient length to be analytical
    // Short tool narrations like "我先全局定位该文件" (len~30) are excluded
    const cjkChars = (trimmed.match(/[\u4e00-\u9fff\u3400-\u4dbf\uF900-\uFAFF]/g) || []).length;
    if (cjkChars >= 15 && trimmed.length >= 40) {
      positiveSignals++;
    } else if (cjkChars >= 10 && trimmed.length >= 60) {
      positiveSignals++;
    } else if (/[A-Z][^.!?]*[.!?]/.test(trimmed) && trimmed.length > 60) {
      // Complete English sentence of decent length
      positiveSignals++;
    }

    // Track consecutive clean text lines (paragraph = positive signal)
    const isNoise = NOISE_LINE_PATTERNS.some(p => p.test(trimmed));
    if (isNoise) {
      noiseLines++;
      consecutiveCleanText = 0;
    } else {
      consecutiveCleanText++;
      if (consecutiveCleanText >= 3) {
        positiveSignals++; // 3+ consecutive non-noise lines = paragraph
        consecutiveCleanText = 0; // Reset to avoid double-counting
      }
    }

    exposedLines++;
  }

  return { exposedLines, noiseLines, positiveSignals, totalLines: totalNonEmpty };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute rough text overlap ratio between two strings.
 * Uses 4-gram Jaccard similarity for efficiency.
 */
function computeOverlapRatio(a: string, b: string): number {
  const ngramSize = 4;
  const gramsA = extractNgrams(a.toLowerCase(), ngramSize);
  const gramsB = extractNgrams(b.toLowerCase(), ngramSize);

  if (gramsA.size === 0 || gramsB.size === 0) return 0;

  let intersection = 0;
  for (const gram of gramsA) {
    if (gramsB.has(gram)) intersection++;
  }

  const union = gramsA.size + gramsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function extractNgrams(text: string, n: number): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i <= text.length - n; i++) {
    grams.add(text.substring(i, i + n));
  }
  return grams;
}
