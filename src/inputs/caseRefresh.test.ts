import { describe, expect, it } from 'vitest';
import { CASE, SNAPSHOT } from '../../tests/helpers/generationFixtures.js';
import { SnapshotFacts } from '../sf/data/plan.js';
import { refreshCaseWording } from './caseRefresh.js';

const changedSnapshot = (message: string): SnapshotFacts => {
  const s = structuredClone(SNAPSHOT);
  s.info.id = 'snap-test-2';
  const vr = s.components.find((c) => c.apiName === 'Contact.Phone_Must_Be_10_Digits')!;
  vr.body = { ...vr.body, errorMessage: message };
  return new SnapshotFacts(s);
};

describe('case wording follows the snapshot (operator 2026-11-26)', () => {
  const tc = {
    ...CASE,
    snapshotId: SNAPSHOT.info.id,
    steps: [
      {
        ...CASE.steps[0]!,
        expected: {
          ...CASE.steps[0]!.expected,
          text: "Contact is not saved and validation error 'Enter a 10-digit phone number.' is displayed on Phone",
        },
      },
    ],
  };
  const old = new SnapshotFacts(SNAPSHOT);
  const factsOf = (id: string): SnapshotFacts | undefined => (id === SNAPSHOT.info.id ? old : undefined);

  it('replaces a quoted old rule message with the new one and moves the case to the new snapshot', () => {
    const r = refreshCaseWording([tc], factsOf, changedSnapshot('Phone must be exactly 10 digits.'));
    expect(r.cases[0]!.steps[0]!.expected.text).toBe(
      "Contact is not saved and validation error 'Phone must be exactly 10 digits.' is displayed on Phone",
    );
    expect(r.cases[0]!.snapshotId).toBe('snap-test-2');
    expect(r.changes[0]).toContain('"Enter a 10-digit phone number." → "Phone must be exactly 10 digits."');
    expect(tc.steps[0]!.expected.text).toContain('Enter a 10-digit'); // input untouched
  });

  it('changes nothing when the message is unchanged or the case snapshot is unknown', () => {
    expect(refreshCaseWording([tc], factsOf, changedSnapshot('Enter a 10-digit phone number.')).changes).toEqual([]);
    expect(refreshCaseWording([tc], () => undefined, changedSnapshot('X.')).changes).toEqual([]);
  });
});
