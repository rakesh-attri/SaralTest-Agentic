// Case wording follows the org (operator 2026-11-26): when a validation rule's error message changed between the
// snapshot a case was designed on and the latest snapshot, expected results that quote the old message are updated
// to the new one. Only exact quotes of the old org text are replaced; nothing is invented.
import type { TestCase } from '../core/schemas/testCase.js';
import type { SnapshotFacts } from '../sf/data/plan.js';

const messages = (f: SnapshotFacts): Map<string, string> => {
  const m = new Map<string, string>();
  for (const c of f.snap.components) {
    const msg = c.body?.['errorMessage'];
    if (c.type === 'ValidationRule' && c.evidenceStatus !== 'UNKNOWN' && typeof msg === 'string' && msg.trim())
      m.set(c.apiName, msg);
  }
  return m;
};

export function refreshCaseWording(
  cases: readonly TestCase[],
  factsOf: (snapshotId: string) => SnapshotFacts | undefined,
  latest: SnapshotFacts,
): { cases: TestCase[]; changes: string[] } {
  const out = structuredClone(cases) as TestCase[];
  const changes: string[] = [];
  const now = messages(latest);
  const cache = new Map<string, Map<string, string> | undefined>();
  for (const tc of out) {
    if (tc.snapshotId === latest.snapshotId) continue;
    if (!cache.has(tc.snapshotId)) {
      const f = factsOf(tc.snapshotId);
      cache.set(tc.snapshotId, f ? messages(f) : undefined);
    }
    const before = cache.get(tc.snapshotId);
    if (!before) continue;
    const changedBefore = changes.filter((c) => c.includes(' expected: ')).length;
    tc.steps.forEach((st, n) => {
      for (const [rule, old] of before) {
        const next = now.get(rule);
        if (!st.expected.text.includes(old)) continue;
        if (next === undefined) {
          changes.push(
            `${tc.id} step ${String(n + 1)}: quotes the message of ${rule}, which is no longer in ${latest.snapshotId} — not changed`,
          );
          continue;
        }
        if (next === old) continue;
        st.expected.text = st.expected.text.split(old).join(next);
        changes.push(
          `${tc.id} step ${String(n + 1)} expected: "${old}" → "${next}" (${rule}, ${tc.snapshotId} → ${latest.snapshotId})`,
        );
      }
    });
    if (changes.filter((c) => c.includes(' expected: ')).length > changedBefore) tc.snapshotId = latest.snapshotId;
  }
  return { cases: out, changes };
}
