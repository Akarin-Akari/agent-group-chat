import { Message, Participant, ContextFormat } from '../types/index.js';
import { estimateTokens } from './token-estimator.js';

interface FormatInput {
  messages: Message[];
  participants: Map<string, Participant>;
  pinnedMessages: Message[];
  format: ContextFormat;
  maxTokens: number;
  roomName: string;
}

interface FormatOutput {
  context: string;
  tokenEstimate: number;
  truncated: boolean;
  messageCount: number;
}

/**
 * Format messages into a context string suitable for AI prompt injection.
 */
export function formatContext(input: FormatInput): FormatOutput {
  const { format } = input;

  switch (format) {
    case 'chat':
      return formatChat(input);
    case 'summary':
      return formatSummary(input);
    case 'structured':
      return formatStructured(input);
    default:
      return formatChat(input);
  }
}

// ─── Chat Format ───
// Simple chronological chat log: [ParticipantName]: message

function formatChat(input: FormatInput): FormatOutput {
  const { messages, participants, pinnedMessages, maxTokens, roomName } = input;

  const lines: string[] = [];
  lines.push(`=== Group Chat: ${roomName} ===`);
  lines.push(`Participants: ${Array.from(participants.values()).map(p => `${p.name}${p.model ? ` (${p.model})` : ''}`).join(', ')}`);
  lines.push('');

  // Add pinned messages header if any
  if (pinnedMessages.length > 0) {
    lines.push('📌 Pinned Messages:');
    for (const msg of pinnedMessages) {
      const name = participants.get(msg.participantId)?.name || 'Unknown';
      lines.push(`  [${name}]: ${msg.content}`);
    }
    lines.push('');
    lines.push('--- Chat History ---');
  }

  // Build message lines from oldest to newest
  const msgLines: Array<{ line: string; isPinned: boolean }> = [];
  for (const msg of messages) {
    const name = participants.get(msg.participantId)?.name || 'Unknown';
    const prefix = msg.replyTo ? '↩ ' : '';
    const typeTag = msg.messageType !== 'text' ? `[${msg.messageType}] ` : '';
    const line = `[${name}]: ${prefix}${typeTag}${msg.content}`;
    msgLines.push({ line, isPinned: msg.isPinned });
  }

  // Token-aware truncation: keep newest messages within budget
  const headerText = lines.join('\n');
  let headerTokens = estimateTokens(headerText);
  const remainingBudget = maxTokens - headerTokens;

  let truncated = false;
  const keptLines: string[] = [];
  let usedTokens = 0;

  // Iterate from newest to oldest, collect what fits
  for (let i = msgLines.length - 1; i >= 0; i--) {
    const lineTokens = estimateTokens(msgLines[i].line);
    if (usedTokens + lineTokens > remainingBudget && remainingBudget > 0) {
      truncated = true;
      break;
    }
    usedTokens += lineTokens;
    keptLines.unshift(msgLines[i].line);
  }

  if (truncated) {
    lines.push(`[... ${messages.length - keptLines.length} earlier messages truncated ...]`);
    lines.push('');
  }
  lines.push(...keptLines);

  const context = lines.join('\n');
  const totalTokens = estimateTokens(context);

  return {
    context,
    tokenEstimate: totalTokens,
    truncated,
    messageCount: keptLines.length,
  };
}

// ─── Summary Format ───
// Condensed bullet-point summary of the discussion

function formatSummary(input: FormatInput): FormatOutput {
  const { messages, participants, pinnedMessages, maxTokens, roomName } = input;

  const lines: string[] = [];
  lines.push(`=== Summary: ${roomName} ===`);
  lines.push(`Participants: ${Array.from(participants.values()).map(p => p.name).join(', ')}`);
  lines.push(`Total messages: ${messages.length}`);
  lines.push('');

  // Pinned messages are key decisions/points
  if (pinnedMessages.length > 0) {
    lines.push('📌 Key Points:');
    for (const msg of pinnedMessages) {
      const name = participants.get(msg.participantId)?.name || 'Unknown';
      lines.push(`  - [${name}]: ${msg.content.slice(0, 200)}${msg.content.length > 200 ? '...' : ''}`);
    }
    lines.push('');
  }

  // Group messages by participant for summary
  const byParticipant = new Map<string, Message[]>();
  for (const msg of messages) {
    const existing = byParticipant.get(msg.participantId) || [];
    existing.push(msg);
    byParticipant.set(msg.participantId, existing);
  }

  lines.push('Contributions:');
  for (const [pid, msgs] of byParticipant) {
    const name = participants.get(pid)?.name || 'Unknown';
    lines.push(`  ${name}: ${msgs.length} messages`);
    // Show last message preview
    const last = msgs[msgs.length - 1];
    lines.push(`    Latest: ${last.content.slice(0, 150)}${last.content.length > 150 ? '...' : ''}`);
  }

  lines.push('');
  lines.push('Recent Discussion (last 10):');
  const recent = messages.slice(-10);
  for (const msg of recent) {
    const name = participants.get(msg.participantId)?.name || 'Unknown';
    lines.push(`  [${name}]: ${msg.content.slice(0, 150)}${msg.content.length > 150 ? '...' : ''}`);
  }

  const context = lines.join('\n');
  const tokenEstimate = estimateTokens(context);

  return {
    context,
    tokenEstimate,
    truncated: false, // Summary is already compact
    messageCount: messages.length,
  };
}

// ─── Structured Format ───
// Organized by message type: decisions, actions, code, discussion

function formatStructured(input: FormatInput): FormatOutput {
  const { messages, participants, pinnedMessages, maxTokens, roomName } = input;

  const lines: string[] = [];
  lines.push(`=== Structured View: ${roomName} ===`);
  lines.push('');

  // Group by type
  const decisions = messages.filter(m => m.messageType === 'decision' || m.isPinned);
  const actions = messages.filter(m => m.messageType === 'action');
  const code = messages.filter(m => m.messageType === 'code');
  const summaries = messages.filter(m => m.messageType === 'summary');
  const discussion = messages.filter(m => m.messageType === 'text' && !m.isPinned);

  if (decisions.length > 0) {
    lines.push('📌 DECISIONS & KEY POINTS:');
    for (const msg of decisions) {
      const name = participants.get(msg.participantId)?.name || 'Unknown';
      lines.push(`  [${name}]: ${msg.content}`);
    }
    lines.push('');
  }

  if (actions.length > 0) {
    lines.push('⚡ ACTION ITEMS:');
    for (const msg of actions) {
      const name = participants.get(msg.participantId)?.name || 'Unknown';
      lines.push(`  [${name}]: ${msg.content}`);
    }
    lines.push('');
  }

  if (code.length > 0) {
    lines.push('💻 CODE SNIPPETS:');
    for (const msg of code) {
      const name = participants.get(msg.participantId)?.name || 'Unknown';
      lines.push(`  [${name}]: ${msg.content.slice(0, 300)}${msg.content.length > 300 ? '...' : ''}`);
    }
    lines.push('');
  }

  if (summaries.length > 0) {
    lines.push('📋 SUMMARIES:');
    for (const msg of summaries) {
      const name = participants.get(msg.participantId)?.name || 'Unknown';
      lines.push(`  [${name}]: ${msg.content}`);
    }
    lines.push('');
  }

  // Discussion: token-aware, keep recent
  lines.push(`💬 DISCUSSION (${discussion.length} messages):`);
  const discussionLines: string[] = [];
  let usedTokens = estimateTokens(lines.join('\n'));
  const remainingBudget = maxTokens - usedTokens;
  let truncated = false;

  for (let i = discussion.length - 1; i >= 0; i--) {
    const name = participants.get(discussion[i].participantId)?.name || 'Unknown';
    const line = `  [${name}]: ${discussion[i].content}`;
    const lineTokens = estimateTokens(line);
    if (usedTokens + lineTokens > maxTokens) {
      truncated = true;
      break;
    }
    usedTokens += lineTokens;
    discussionLines.unshift(line);
  }

  if (truncated) {
    lines.push(`  [... ${discussion.length - discussionLines.length} earlier messages truncated ...]`);
  }
  lines.push(...discussionLines);

  const context = lines.join('\n');

  return {
    context,
    tokenEstimate: estimateTokens(context),
    truncated,
    messageCount: messages.length,
  };
}
