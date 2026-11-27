// Every model attempt that failed or was rejected in this process (Phase 5, operator request): commands print it at
// the end ("Model attempts that failed") and reports include it, so a fallback answer is never shown without the exact
// reason its primary failed. Messages are the provider's own text (redacted by the caller), never a paraphrase.
export interface FailedAttempt {
  at: string;
  agent: string;
  role?: string;
  model: string;
  attempt: number;
  outcome: 'ERROR' | 'INVALID';
  /** IssueKind of the error (TRANSIENT, TOOL_UNAVAILABLE, …) or INVALID_LLM_OUTPUT. */
  kind: string;
  /** HTTP status when the provider sent one. */
  status?: number;
  /** The provider's / validator's exact message. */
  message: string;
  /** Model the chain moved on to (undefined = none left). */
  next?: string;
}

export interface FallbackAnswer {
  at: string;
  agent: string;
  model: string;
}

const failed: FailedAttempt[] = [];
const fallbacks: FallbackAnswer[] = [];

export const attemptLog = {
  fail(a: Omit<FailedAttempt, 'at'>): void {
    failed.push({ at: new Date().toISOString(), ...a });
  },
  fallback(f: Omit<FallbackAnswer, 'at'>): void {
    fallbacks.push({ at: new Date().toISOString(), ...f });
  },
  failed: (): readonly FailedAttempt[] => failed,
  fallbacks: (): readonly FallbackAnswer[] => fallbacks,
  reset(): void {
    failed.length = 0;
    fallbacks.length = 0;
  },
};

/** Console / report block. Empty string when nothing failed. */
export function renderFailedAttempts(maxMessage = 600): string {
  if (!failed.length && !fallbacks.length) return '';
  const L: string[] = ['', 'Model attempts that failed (exact provider / validator messages):'];
  for (const a of failed) {
    const msg = a.message.replace(/\s+/g, ' ').slice(0, maxMessage);
    L.push(
      `  ${a.at.slice(11, 19)} ${a.agent} · ${a.model} · attempt ${String(a.attempt)} · ${a.outcome} ${a.kind}${a.status ? ` (HTTP ${String(a.status)})` : ''}${a.next ? ` → next ${a.next}` : a.outcome === 'ERROR' ? ' → no model left' : ''}`,
      `      ${msg}`,
    );
  }
  for (const f of fallbacks) L.push(`  ANSWERED BY FALLBACK: ${f.agent} · ${f.model} (the primary failed — see above)`);
  return L.join('\n');
}
