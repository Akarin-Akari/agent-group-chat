/**
 * Simple token estimator based on character/word heuristics.
 * Avoids heavy tokenizer dependencies — good enough for context budgeting.
 *
 * Rule of thumb: 1 token ≈ 4 characters (English), ≈ 1.5 characters (CJK)
 */

export function estimateTokens(text: string): number {
  if (!text) return 0;

  // Count CJK characters (they consume more tokens)
  const cjkPattern = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/g;
  const cjkMatches = text.match(cjkPattern);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;

  // Remaining (non-CJK) character count
  const nonCjkLength = text.length - cjkCount;

  // Estimate: ~4 chars/token for Latin, ~1.5 chars/token for CJK
  const latinTokens = Math.ceil(nonCjkLength / 4);
  const cjkTokens = Math.ceil(cjkCount / 1.5);

  return latinTokens + cjkTokens;
}

/**
 * Truncate messages array to fit within a token budget.
 * Keeps the most recent messages (tail), drops oldest first.
 * Always preserves pinned messages.
 */
export function truncateToTokenBudget(
  messages: Array<{ content: string; isPinned?: boolean; formatted?: string }>,
  maxTokens: number
): { kept: typeof messages; truncated: boolean } {
  // Separate pinned (always keep) vs normal
  const pinned = messages.filter(m => m.isPinned);
  const normal = messages.filter(m => !m.isPinned);

  let totalTokens = 0;

  // First account for pinned messages
  for (const m of pinned) {
    totalTokens += estimateTokens(m.formatted || m.content);
  }

  // If pinned alone exceed budget, still keep them but flag truncated
  if (totalTokens >= maxTokens) {
    return { kept: pinned, truncated: true };
  }

  const remainingBudget = maxTokens - totalTokens;
  const keptNormal: typeof messages = [];
  let normalTokens = 0;

  // Iterate from newest to oldest (messages should be sorted chronologically,
  // so we reverse to prioritize recent)
  for (let i = normal.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(normal[i].formatted || normal[i].content);
    if (normalTokens + tokens > remainingBudget) {
      break;
    }
    normalTokens += tokens;
    keptNormal.unshift(normal[i]); // prepend to maintain order
  }

  const allKept = [...keptNormal];
  // Insert pinned messages back in their original positions
  // For simplicity, just append pinned at their natural position
  // (they're already in the messages array)
  const keptIds = new Set(allKept.map((_, i) => i));
  const result = messages.filter(m => m.isPinned || keptNormal.includes(m));

  return {
    kept: result,
    truncated: keptNormal.length < normal.length,
  };
}
