import { describe, expect, it } from 'vitest';
import { EvidenceIndex } from '../../oracles/index.js';
import { assessRisks, deriveObligations, resolvePersona, tierObligations, withRiskScores } from './index.js';
import {
  clarifications,
  components,
  docs,
  findings,
  manualTests,
  orgChecks,
  requirements,
} from '../../../tests/helpers/designFixtures.js';

const index = new EvidenceIndex({ docs, requirements, findings, clarifications, orgChecks, components, manualTests });
const personas = [{ id: 'system-admin', profile: 'System Administrator' }];
const base = { requirements, index, orgChecks, components, manualTests, personas, defaultPersona: 'system-admin' };

describe('resolvePersona', () => {
  it('maps a requirement persona through the org cross-check profile', () => {
    const p = resolvePersona('Read Only User', personas, orgChecks);
    expect(p).toMatchObject({ id: 'read-only', profile: 'Read Only', available: false });
    expect(p.note).toMatch(/OC-009/);
  });
  it('is available when a test user has that profile', () => {
    const p = resolvePersona('Read Only User', [...personas, { id: 'ro', profile: 'Read Only' }], orgChecks);
    expect(p).toMatchObject({ id: 'ro', available: true });
  });
  it('the configured default persona is available', () => {
    expect(resolvePersona('system-admin', personas).available).toBe(true);
  });
});

describe('deriveObligations', () => {
  const obs = deriveObligations({ ...base, reverify: ['manual-test:MTC-001'] });
  const of = (req: string) => obs.filter((o) => o.requirementId === req);

  it('every story AC gets a mandatory obligation', () => {
    const acs = docs[0]?.sections.filter((s) => s.kind === 'ac').map((s) => s.ref) ?? [];
    for (const ac of acs) expect(obs.some((o) => o.ref === ac && o.isAc)).toBe(true);
  });

  it('validation requirements get one negative per settling or contesting org check', () => {
    const neg = of('SF-219-R41').filter((o) => o.kind === 'negative');
    expect(neg.map((o) => o.evidenceIds[0])).toEqual(['OC-003', 'OC-004']);
    expect(neg.find((o) => o.evidenceIds[0] === 'OC-003')?.level).toBe('UNKNOWN_OR_CONTRADICTORY');
    expect(neg.find((o) => o.evidenceIds[0] === 'OC-004')?.level).toBe('DECLARED_CONFIG');
  });

  it('the Phone format negative is assertable through OC-007 while "Phone required" is not', () => {
    const neg = of('SF-219-R14').filter((o) => o.kind === 'negative');
    expect(neg.find((o) => o.evidenceIds.includes('OC-007'))?.level).toBe('DECLARED_CONFIG');
    expect(neg.find((o) => o.evidenceIds.includes('OC-006'))?.level).toBe('UNKNOWN_OR_CONTRADICTORY');
    // contested BR-04 is never offered as evidence
    expect(neg.every((o) => !o.evidenceIds.includes('BRD-CON-012#BR-04'))).toBe(true);
  });

  it('numeric limits give boundary obligations at n-1/n/n+1, once per limit', () => {
    const b = of('SF-219-R10').filter((o) => o.kind === 'boundary');
    expect(b).toHaveLength(1);
    expect(b[0]?.values).toEqual(['79', '80', '81']);
    expect(b[0]?.evidenceIds).toContain('Field:Contact.LastName');
    const phone = of('SF-219-R14').filter((o) => o.kind === 'boundary');
    expect(phone).toHaveLength(1);
    expect(phone[0]?.values).toEqual(['9', '10', '11']);
  });

  it('security requirements get a deny obligation with the non-admin persona', () => {
    const deny = of('SF-219-R16').find((o) => o.kind === 'deny');
    expect(deny).toMatchObject({ persona: 'read-only', ref: 'AC6' });
    expect(deny?.evidenceIds).toContain('OC-010');
    expect(deny?.level).toBe('DECLARED_CONFIG');
  });

  it('bulk obligation when a trigger runs on a touched object', () => {
    const bulk = obs.filter((o) => o.kind === 'bulk');
    expect(bulk).toHaveLength(1);
    expect(bulk[0]?.values).toEqual(['ApexTrigger:Contact.ContactTrigger']);
  });

  it('RE_VERIFY manual tests become regression obligations', () => {
    const reg = obs.find((o) => o.kind === 'regression');
    expect(reg).toMatchObject({ requirementId: 'SF-219-R36', manualTestIds: ['MTC-001'] });
  });

  it('obligations reuse matching manual tests', () => {
    expect(of('SF-219-R10').find((o) => o.kind === 'positive')?.manualTestIds).toEqual(['MTC-002']);
  });
});

describe('assessRisks', () => {
  const risks = assessRisks({
    requirements,
    index,
    orgChecks,
    manualTests,
    defects: [
      {
        key: 'SF-100',
        summary: 'Account Number_of_Contacts__c not updated',
        components: [],
        labels: [],
        source: { type: 'jira', ref: 'SF-100', hash: 'x' },
      },
    ],
    impact: {
      dependencies: [],
      regressionCandidates: [],
      riskScores: {},
      changed: [],
      impacted: [],
      reverify: ['requirement:SF-219-R14'],
    },
  });
  const byReq = (id: string) => risks.find((r) => r.requirementIds.includes(id));

  it('org conflicts, failed manual tests and RE_VERIFY raise likelihood with evidence', () => {
    expect(byReq('SF-219-R41')?.drivers.map((d) => d.kind)).toEqual(['org-conflict']);
    expect(byReq('SF-219-R10')?.drivers.map((d) => d.kind)).toEqual(['manual-test-failed']);
    expect(byReq('SF-219-R14')?.drivers.map((d) => d.kind)).toContain('re-verify');
    expect(byReq('SF-219-R23')?.drivers.map((d) => d.kind)).toEqual(['org-not-found', 'past-defect']);
  });

  it('scores are likelihood × impact weight; security and data are high impact', () => {
    const r16 = byReq('SF-219-R16');
    expect(r16?.impact).toBe('H');
    expect(r16?.score).toBe(r16?.likelihood);
    const r10 = byReq('SF-219-R10');
    expect(r10?.score).toBe(Math.round((r10?.likelihood ?? 0) * 0.6 * 100) / 100);
  });

  it('AC-covering and past-defect risks are mandatory', () => {
    expect(byReq('SF-219-R10')?.tier).toBe('mandatory');
    expect(byReq('SF-219-R23')?.tier).toBe('mandatory'); // past defect, no AC
  });

  it('a low risk never removes AC coverage', () => {
    const low = assessRisks({
      requirements: requirements.map((r) => ({
        ...r,
        risk: 'LOW' as const,
        type: 'ui' as const,
        status: 'EXECUTABLE' as const,
      })),
      index,
      orgChecks: [],
      manualTests: [],
    });
    const obs = tierObligations(deriveObligations(base), low);
    for (const o of obs.filter((x) => x.isAc)) expect(o.tier).toBe('mandatory');
    expect(low.find((r) => r.requirementIds.includes('SF-219-R23'))?.tier).toBe('optional');
  });

  it('riskScores are written into the impact report', () => {
    expect(withRiskScores(undefined, risks).riskScores['SF-219-R16']).toBe(byReq('SF-219-R16')?.score);
  });
});

describe('live-demo regressions (obligations)', () => {
  it('a boundary picks the most specific field of the requirement\'s object ("Last Name", not Account "Name")', () => {
    const accountName = {
      ...components[1]!,
      type: 'Field',
      apiName: 'Account.Name',
      label: 'Account Name',
      parent: 'Account',
      body: { type: 'string', length: 255 },
    };
    const accountPhone = { ...components[2]!, apiName: 'Account.Phone', label: 'Account Phone', parent: 'Account' };
    const reqs = requirements.map((r) =>
      r.id === 'SF-219-R10' ? { ...r, businessObjective: 'Last Name is required on the Contact' } : r,
    );
    const obs = deriveObligations({
      ...base,
      requirements: reqs,
      components: [accountName, accountPhone, ...components],
    });
    const b = obs.find((o) => o.requirementId === 'SF-219-R10' && o.kind === 'boundary');
    expect(b?.evidenceIds).toContain('Field:Contact.LastName');
    expect(b?.evidenceIds).not.toContain('Field:Account.Name');
  });

  it('an obligation whose only sections are contested still cites them (UNKNOWN) instead of nothing', () => {
    const r = {
      ...requirements[3]!,
      id: 'SF-219-R99',
      sources: [requirements[3]!.sources[1]!],
      type: 'functional' as const,
    };
    const idx = new EvidenceIndex({
      docs,
      requirements: [r],
      findings,
      clarifications,
      orgChecks: [],
      components,
      manualTests,
    });
    const obs = deriveObligations({ ...base, requirements: [r], index: idx, orgChecks: [] });
    const pos = obs.find((o) => o.kind === 'positive');
    expect(pos?.evidenceIds).toEqual(['BRD-CON-012#BR-04']);
    expect(pos?.level).toBe('UNKNOWN_OR_CONTRADICTORY');
  });
});
