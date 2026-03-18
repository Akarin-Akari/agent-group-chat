# Response Validator (Layer 1 Heuristic Gate) - Status Document

> **Date**: 2026-03-19
> **Status**: DISABLED (temporarily)
> **Author**: Claude Opus 4.6

---

## Overview

The response validator is a heuristic gate that validates relay responses BEFORE they are written to chat.md. It is part of a 3-layer defense system:

- **Layer 1**: Heuristic gate (this module) — `src/tools/response-validator.ts`
- **Layer 2**: `delete_message` tool — `src/tools/delete-message.ts` (ACTIVE)
- **Layer 3**: `moderation_level` room config — in `create-room.ts` + `relay-common.ts` (ACTIVE but gate disabled)

## Current Architecture

### Design Principles (v2 rewrite)

1. **Noise Ratio Analysis** — Detects how much of the response is CLI garbage, not whether it contains any
2. **Markdown-Aware** — Content inside \`\`\`code blocks\`\`\` and `>` quote blocks is EXCLUDED from noise detection
3. **Positive Signal Immunity** — Responses with enough analytical structure pass even if noise ratio is moderate

### Algorithm

```
1. Strip ANSI codes + trim
2. Empty (0 chars) or near-empty (<2 chars) -> blocked
3. Trivial responses ("ready", "(empty response)") -> blocked
4. Parrot detection (>80% Jaccard overlap with prompt) -> blocked
5. Markdown-aware line analysis:
   a. Lines inside ```code blocks``` are "protected" (excluded from noise counting)
   b. Exposed lines are checked against NOISE_LINE_PATTERNS
   c. Positive signals counted: markdown headings, lists, bold, CJK paragraphs, English sentences
6. Decision:
   - noiseRatio > 70% AND positiveSignals < 2 -> blocked
   - noiseRatio > 40% AND positiveSignals < 2 -> suspect
   - length < 50 -> suspect
   - else -> passed
```

### Moderation Levels

| Level | blocked response | suspect response | normal response |
|-------|:---:|:---:|:---:|
| `none` | writes to chat.md | writes to chat.md | writes to chat.md |
| `normal` (default) | REJECTED, not written | writes + warning log | writes |
| `strict` | REJECTED | REJECTED, held for manual approval | writes |

## Known Issue: BUG-001 False Negative

**Status**: UNRESOLVED (reason for disabling)

The BUG-001 garbage sample (Codex CLI search logs from wrong cwd) is not reliably blocked. Root cause:

1. The garbage contains short Chinese narration lines ("我先全局定位该文件再读取内容。") that approach positive signal thresholds
2. Bare directory names (__pycache__, .ace-tool) were not in noise patterns (FIXED — added 3 new patterns)
3. Even after fixes, the noise ratio lands at ~57% with positive signals near threshold — borderline case

### What was tried

| Attempt | Result |
|---------|--------|
| v1: Keyword matching (2+ shell patterns = blocked) | Blocks BUG-001 but FALSE POSITIVES on legitimate code discussions |
| v2: Noise ratio + markdown-aware + positive signal immunity | Correctly passes code discussions but MISSES BUG-001 (false negative) |
| Tightened CJK thresholds (cjk>=15 && len>=40) | Still borderline — consecutive dir listing lines trigger paragraph signal |
| Added bare path/dotfile/dirname noise patterns | Improved ratio but still not enough with Chinese narration lines |

### Root Cause Analysis

The fundamental tension: BUG-001 garbage contains a MIX of noise (shell commands) and quasi-legitimate text (Codex narrating its own tool calls in Chinese). This makes it structurally different from pure CLI dumps — it's a "narrated tool session" which is hard to distinguish from "developer analyzing CLI output" using purely structural heuristics.

### Recommended Next Steps

1. **Option A**: Add a "Codex tool narration" noise pattern (lines matching "我先...", "正在...", "当前...目录..." etc.) — fragile, language-dependent
2. **Option B**: Check if the response contains any markdown formatting AT ALL — BUG-001 has zero markdown, while legitimate analysis always has some structure
3. **Option C**: Use a "no markdown structure" signal as a negative indicator — if response has 0 positive signals AND noise ratio > 40%, block regardless
4. **Option D**: Accept the false negative and rely on Layer 2 (delete_message) for this edge case

## Files

| File | Role | Status |
|------|------|--------|
| `src/tools/response-validator.ts` | Heuristic validation logic | Code present, DISABLED at integration point |
| `src/tools/relay-common.ts` | Integration point (calls validator) | Gate logic DISABLED |
| `src/tools/delete-message.ts` | Layer 2: post-hoc message deletion | ACTIVE |
| `src/tools/create-room.ts` | Layer 3: moderation_level parameter | ACTIVE (parameter accepted, stored in meta) |
| `src/storage/file-store.ts` | deleteMessageBySeq + getModerationLevel | ACTIVE |
| `src/manager.ts` | deleteMessage + getModerationLevel | ACTIVE |
| `src/types/index.ts` | ModerationLevel type | ACTIVE |
| `test-validator.cjs` | Test suite (8 cases, 7/8 passing) | For development use |
| `debug-validator.cjs` | Debug diagnostic script | For development use |

## Test Results (latest)

```
7/8 passed
- [PASS] Legitimate code analysis with shell examples in code blocks
- [PASS] Bug analysis with quoted error logs
- [PASS] Empty response -> blocked
- [PASS] Short response (yes) -> suspect
- [PASS] Normal analytical response (Chinese) -> passed
- [PASS] Codex noise markers only -> blocked
- [PASS] Mixed: some noise but strong analysis -> passed
- [FAIL] BUG-001 garbage -> should be blocked, got passed
```

---

*Document created 2026-03-19 by Claude Opus 4.6*
