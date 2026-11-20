import type { EvidenceIndex } from './evidenceIndex.js';

/**
 * Grounding check (CLAUDE.md rule 12): every concrete value an expectation names — quoted text, numbers — must appear in
 * the evidence it cites, or in the step's own action (test input). A guessed error message or an invented limit is
 * rejected. Free wording around the values is allowed.
 */
export interface GroundingProblem {
  value: string;
  message: string;
}

const norm = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim();

export function valuesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/"([^"]{1,200})"|“([^”]{1,200})”|'([^']{3,200})'/g)) {
    const v = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (v) out.add(v);
  }
  // Numbers outside quotes (a quoted message is checked as a whole).
  const unquoted = text.replace(/"[^"]{1,200}"|“[^”]{1,200}”|'[^']{3,200}'/g, ' ');
  for (const m of unquoted.matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w.])/g)) out.add(m[0]);
  return [...out];
}

export function groundingProblems(
  index: EvidenceIndex,
  expectedText: string,
  cited: readonly string[],
  action = '',
): GroundingProblem[] {
  const evidence = norm(
    cited
      .map((c) => index.get(c)?.text ?? '')
      .concat(action)
      .join(' \n '),
  );
  const problems: GroundingProblem[] = [];
  for (const v of valuesIn(expectedText)) {
    if (!evidence.includes(norm(v))) {
      problems.push({
        value: v,
        message: `"${v}" is not in the cited evidence (${cited.join(', ') || 'none'}) nor in the step action — do not invent values; cite the evidence that states it or describe the outcome without it`,
      });
    }
  }
  return problems;
}
