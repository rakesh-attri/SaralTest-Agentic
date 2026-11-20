import type { BaseMessage } from '@langchain/core/messages';
import { HardStopError } from '../core/errors.js';

/** Flatten message content (string or content blocks) into plain text for scanning. */
export function messageText(m: BaseMessage): string {
  const c: unknown = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((part: unknown) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('\n');
  }
  return '';
}

/**
 * Hard stop if any known secret value is about to leave the machine in a prompt (CLAUDE.md rule 4/10).
 * Only the *name* of the check is reported, never the value.
 */
export function assertNoSecrets(texts: readonly string[], secrets: readonly string[], where: string): void {
  if (!secrets.length) return;
  for (const t of texts) {
    for (const s of secrets) {
      if (s && t.includes(s)) {
        throw new HardStopError('SECRET_IN_PROMPT', `a configured secret value was found in ${where}; call refused`);
      }
    }
  }
}
