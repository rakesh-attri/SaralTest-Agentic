import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DiscoveredComponent, DiscoveryResult } from '../sf/discovery/types.js';
import { diffSnapshots } from './diff.js';
import { canonicalJson, contentHash } from './hash.js';
import { SnapshotStore } from './snapshotStore.js';

const ORG = '00DFIXTURE00000001';
const vr = (formula: string): DiscoveredComponent => ({
  type: 'ValidationRule',
  apiName: 'Contact.Phone_Format',
  parent: 'Contact',
  body: { active: true, errorConditionFormula: formula, errorMessage: 'm' },
  evidenceStatus: 'DECLARED',
});
const field = (name: string, body: Record<string, unknown> = { type: 'string' }): DiscoveredComponent => ({
  type: 'Field',
  apiName: `Contact.${name}`,
  parent: 'Contact',
  body,
  evidenceStatus: 'DECLARED',
});
const discovery = (components: DiscoveredComponent[], at: string, objects = ['Contact']): DiscoveryResult => ({
  environment: 'FIXTURE',
  orgId: ORG,
  apiVersion: '62.0',
  objects,
  components,
  dependencies: [
    {
      fromType: 'ValidationRule',
      fromName: 'Contact.Phone_Format',
      toType: 'Field',
      toName: 'Contact.Phone',
      kind: 'references',
      source: 'formula',
    },
  ],
  areas: [],
  startedAt: at,
  finishedAt: at,
});

describe('canonical hashing', () => {
  it('ignores key order, keeps array order, and is type-prefixed', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(contentHash('Field', { a: 1, b: 2 })).toBe(contentHash('Field', { b: 2, a: 1 }));
    expect(contentHash('Field', [1, 2])).not.toBe(contentHash('Field', [2, 1]));
    expect(contentHash('Field', { a: 1 })).not.toBe(contentHash('Layout', { a: 1 }));
  });
});

describe('SnapshotStore + diff', () => {
  const store = (): SnapshotStore =>
    new SnapshotStore(join(mkdtempSync(join(tmpdir(), 'knowledge db ')), 'knowledge.db'));

  it('stores immutable snapshots and detects a changed validation rule with the changed keys', () => {
    const s = store();
    const one = s.save({
      discovery: discovery([vr('A'), field('Phone'), field('Fax')], '2026-11-20T10:00:00.000Z'),
      orgAlias: 'fixture',
      release: 'fixture',
    });
    const two = s.save({
      discovery: discovery([vr('B'), field('Phone'), field('Email')], '2026-11-20T11:00:00.000Z'),
      orgAlias: 'fixture',
      release: 'fixture',
    });
    expect(() =>
      s.save({
        discovery: discovery([], '2026-11-20T12:00:00.000Z'),
        orgAlias: 'fixture',
        release: 'fixture',
        id: one.info.id,
      }),
    ).toThrow(/immutable/);
    expect(s.latest(ORG)?.id).toBe(two.info.id);
    expect(s.latest(ORG, two.info.id)?.id).toBe(one.info.id);

    const a = s.get(one.info.id);
    const b = s.get(two.info.id);
    expect(a?.dependencies).toHaveLength(1);
    const d = diffSnapshots(
      { id: one.info.id, orgId: ORG, objects: one.info.objects, components: a?.components ?? [] },
      { id: two.info.id, orgId: ORG, objects: two.info.objects, components: b?.components ?? [] },
    );
    expect(d.counts).toEqual({ added: 1, removed: 1, changed: 1, unknown: 0 });
    expect(d.entries.find((e) => e.change === 'changed')).toMatchObject({
      type: 'ValidationRule',
      apiName: 'Contact.Phone_Format',
      changedKeys: ['errorConditionFormula'],
    });
    s.close();
  });

  it('an unreadable area is "unknown", never "removed" or "added"', () => {
    const before = [vr('A'), field('Phone')];
    const after: DiscoveredComponent[] = [
      {
        type: 'ValidationRule',
        apiName: 'Contact.*',
        parent: 'Contact',
        body: { reason: 'INSUFFICIENT_ACCESS' },
        evidenceStatus: 'UNKNOWN',
      },
      field('Phone'),
    ];
    const s = store();
    const x = s.save({ discovery: discovery(before, '2026-11-20T10:00:00.000Z'), orgAlias: 'f', release: 'r' });
    const y = s.save({ discovery: discovery(after, '2026-11-20T11:00:00.000Z'), orgAlias: 'f', release: 'r' });
    const d = diffSnapshots(
      { id: x.info.id, orgId: ORG, objects: ['Contact'], components: x.components },
      { id: y.info.id, orgId: ORG, objects: ['Contact'], components: y.components },
    );
    expect(d.counts.removed).toBe(0);
    expect(d.entries[0]).toMatchObject({ apiName: 'Contact.Phone_Format', change: 'unknown' });
    expect(y.info.unknownCount).toBe(1);
    // and back: newly readable again → unknown, not added
    const back = diffSnapshots(
      { id: y.info.id, orgId: ORG, objects: ['Contact'], components: y.components },
      { id: x.info.id, orgId: ORG, objects: ['Contact'], components: x.components },
    );
    expect(back.counts.added).toBe(0);
  });

  it('only compares objects in both scopes and refuses cross-org diffs', () => {
    const acc: DiscoveredComponent = {
      type: 'Field',
      apiName: 'Account.Name',
      parent: 'Account',
      body: {},
      evidenceStatus: 'DECLARED',
    };
    const s = store();
    const x = s.save({
      discovery: discovery([acc, field('Phone')], '2026-11-20T10:00:00.000Z', ['Account', 'Contact']),
      orgAlias: 'f',
      release: 'r',
    });
    const y = s.save({
      discovery: discovery([field('Phone')], '2026-11-20T11:00:00.000Z', ['Contact']),
      orgAlias: 'f',
      release: 'r',
    });
    const d = diffSnapshots(
      { id: x.info.id, orgId: ORG, objects: x.info.objects, components: x.components },
      { id: y.info.id, orgId: ORG, objects: y.info.objects, components: y.components },
    );
    expect(d.entries).toEqual([]);
    expect(d.comparedObjects).toEqual(['Contact']);
    expect(() =>
      diffSnapshots(
        { id: 'a', orgId: ORG, objects: [], components: [] },
        { id: 'b', orgId: '00D000000000000AAA', objects: [], components: [] },
      ),
    ).toThrow(/different orgs/);
  });

  it('records lineage and RE_VERIFY marks (idempotent, clearable)', () => {
    const s = store();
    s.recordLineage({
      assetType: 'test-case',
      assetId: 'TC-1',
      snapshotId: 'snap-1',
      specHash: 'abc',
      observationIds: ['obs-1'],
    });
    expect(s.lineageOf('test-case', 'TC-1')[0]).toMatchObject({ snapshotId: 'snap-1', observationIds: ['obs-1'] });
    const mark = {
      assetType: 'manual-test' as const,
      assetId: 'MTC-003',
      componentType: 'ValidationRule',
      componentName: 'Contact.Phone_Format',
      change: 'changed' as const,
      path: ['MTC-003 -covers-> Contact.Phone', 'Contact.Phone_Format -references-> Contact.Phone'],
      snapshotId: 'snap-2',
    };
    s.markReverify([mark, mark]);
    expect(s.openReverify()).toHaveLength(1);
    expect(s.clearReverify('manual-test', 'MTC-003')).toBe(1);
    expect(s.openReverify()).toHaveLength(0);
  });
});
