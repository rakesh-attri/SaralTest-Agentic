// Shared formatting for every report writer (analysis, design, build, execution, JIRA draft).
import type { Environment } from '../core/schemas/common.js';

/** Markdown table cell: no pipes, no line breaks. */
export const md = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

/** HTML text / attribute escaping. */
export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** How an environment is named in every report (CLAUDE.md rule 13: non-LIVE never reads as a Salesforce result). */
export function environmentLabel(env: Environment): string {
  return env === 'LIVE'
    ? 'LIVE (Salesforce org)'
    : env === 'FIXTURE'
      ? 'FIXTURE — offline fixture, NOT a Salesforce result'
      : 'MOCK — mock provider, NOT a real result';
}

/** Markdown banner for non-LIVE output (empty for LIVE). */
export function environmentBanner(env: Environment): string {
  return env === 'LIVE' ? '' : `> **${environmentLabel(env)}**. Never report this as a real Salesforce pass.`;
}
