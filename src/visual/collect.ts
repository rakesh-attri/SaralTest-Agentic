// Playwright JSON of the visual suite → candidates, layout findings and a11y findings (PLAN.md §7g). No LLM, no
// judgement: a difference is a candidate (DIFF / NO_BASELINE / RE_APPROVE), never a defect. Images are copied into
// `runs/<id>/visual/images/` so the report and `qa visual approve` work from the run folder alone.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import type { Environment } from '../core/schemas/common.js';
import {
  A11yFinding,
  A11yRegionCheck,
  LayoutFinding,
  VisualCandidate,
  snapshotName,
  type BaselineManifest,
  type VisualRegion,
} from '../core/schemas/visual.js';
import { baselineImage, sha256Buffer, trustBaseline } from './baselines.js';

const Attachment = z.object({
  name: z.string(),
  path: z.string().optional(),
  body: z.string().optional(),
  contentType: z.string().optional(),
});
const Result = z.object({
  status: z.string().optional(),
  errors: z.array(z.object({ message: z.string().default('') })).default([]),
  attachments: z.array(Attachment).default([]),
});
const Test = z.object({ projectName: z.string().default(''), results: z.array(Result).default([]) });
const Spec = z.object({ title: z.string(), tests: z.array(Test).default([]) });
interface SuiteT {
  specs: z.infer<typeof Spec>[];
  suites?: SuiteT[] | undefined;
}
const Suite: z.ZodType<SuiteT> = z.lazy(() =>
  z.object({ specs: z.array(Spec).default([]), suites: z.array(Suite).optional() }),
);
export const VisualPlaywrightJson = z.object({
  suites: z.array(Suite).default([]),
  errors: z.array(z.object({ message: z.string().default('') })).default([]),
});
export type VisualPlaywrightJson = z.infer<typeof VisualPlaywrightJson>;

const LayoutAttachment = z.object({ region: z.string(), findings: z.array(LayoutFinding).default([]) });
const A11yViolation = z.object({
  ruleId: z.string(),
  impact: z.string().nullable().default(null),
  targets: z.number().int().nonnegative(),
  help: z.string().default(''),
});
const A11yAttachment = z.object({
  region: z.string(),
  viewport: z.string(),
  failing: z.array(A11yViolation).default([]),
  baseline: z.array(A11yViolation).default([]),
  unnamed: z.array(z.string()).default([]),
  tabOrder: z
    .object({ inOrder: z.boolean(), missing: z.array(z.string()), leftScope: z.boolean() })
    .nullable()
    .default(null),
});

export interface CollectInput {
  pw: VisualPlaywrightJson;
  runDir: string;
  /** Baseline folder of this org and its manifest. */
  folder: string;
  manifest: BaselineManifest;
  release: string;
  environment: Environment;
  regions: readonly VisualRegion[];
  ratioFor: (region: VisualRegion) => number;
}

export interface TestOutcome {
  title: string;
  project: string;
  state: string;
  error?: string;
}

export interface Collected {
  candidates: VisualCandidate[];
  layout: LayoutFinding[];
  a11y: A11yFinding[];
  a11yChecks: A11yRegionCheck[];
  tests: TestOutcome[];
}

function* specs(suites: readonly SuiteT[]): Generator<z.infer<typeof Spec>> {
  for (const s of suites) {
    yield* s.specs;
    if (s.suites) yield* specs(s.suites);
  }
}

const PROJECT = /^visual-(.+)-([a-z0-9]+)$/;
// eslint-disable-next-line no-control-regex -- strip ANSI colour codes from Playwright error text
const plain = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');
const RATIO = /(\d+) pixels \(ratio ([\d.]+) of all image pixels\) are different/;

/** Width / height from a PNG's IHDR chunk (undefined when the bytes are not a PNG). */
export function pngSize(b: Buffer): { width: number; height: number } | undefined {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return undefined;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function body(a: z.infer<typeof Attachment>): Buffer | undefined {
  if (a.body !== undefined) return Buffer.from(a.body, 'base64');
  if (a.path && existsSync(a.path)) return readFileSync(a.path);
  return undefined;
}

function json<T>(a: z.infer<typeof Attachment> | undefined, schema: z.ZodType<T>): T | undefined {
  const b = a ? body(a) : undefined;
  if (!b) return undefined;
  const r = schema.safeParse(JSON.parse(b.toString('utf8')));
  return r.success ? r.data : undefined;
}

export function collectVisual(i: CollectInput): Collected {
  const imgDir = join(i.runDir, 'visual', 'images');
  mkdirSync(imgDir, { recursive: true });
  const rel = (f: string): string => relative(i.runDir, f).split('\\').join('/');
  const save = (name: string, kind: string, data: Buffer | undefined): string | undefined => {
    if (!data) return undefined;
    const f = join(imgDir, `${name}-${kind}.png`);
    writeFileSync(f, data);
    return rel(f);
  };
  const out: Collected = { candidates: [], layout: [], a11y: [], a11yChecks: [], tests: [] };

  for (const spec of specs(i.pw.suites)) {
    for (const t of spec.tests) {
      const m = PROJECT.exec(t.projectName);
      const last = t.results.at(-1);
      if (!m || !last) continue;
      const persona = m[1] ?? '';
      const viewport = m[2] ?? '';
      const errors = last.errors.map((e) => plain(e.message));
      out.tests.push({
        title: spec.title,
        project: t.projectName,
        state: last.status ?? 'unknown',
        ...(errors[0] ? { error: errors[0].split('\n').slice(0, 3).join(' ').slice(0, 400) } : {}),
      });
      const att = (name: string): z.infer<typeof Attachment> | undefined =>
        last.attachments.find((a) => a.name === name);

      // a11y attachments (any spec)
      for (const a of last.attachments.filter((x) => x.name.startsWith('visual-a11y-'))) {
        const v = json(a, A11yAttachment);
        if (!v) continue;
        const region = v.region as VisualRegion;
        const accepted = new Set(
          i.manifest.a11y.find((e) => e.region === region && e.viewport === v.viewport)?.ruleIds ?? [],
        );
        for (const f of v.failing)
          out.a11y.push(A11yFinding.parse({ ...f, region, viewport: v.viewport, status: 'FAIL' }));
        for (const f of v.baseline) {
          out.a11y.push(
            A11yFinding.parse({
              ...f,
              region,
              viewport: v.viewport,
              status: accepted.has(f.ruleId) ? 'BASELINE' : 'NEW_STANDARD',
            }),
          );
        }
        out.a11yChecks.push(
          A11yRegionCheck.parse({
            region,
            viewport: v.viewport,
            tabOrderInOrder: v.tabOrder
              ? v.tabOrder.inOrder && !v.tabOrder.leftScope && !v.tabOrder.missing.length
              : null,
            missingFromTabOrder: v.tabOrder?.missing ?? [],
            unnamedControls: v.unnamed,
          }),
        );
      }

      // screenshots + layout (the regions spec)
      if (!spec.title.startsWith('VIS-')) continue;
      for (const region of i.regions) {
        const name = snapshotName(region, persona, viewport);
        const layout = json(att(`visual-layout-${region}.json`), LayoutAttachment);
        if (layout) out.layout.push(...layout.findings);
        const actual = att(`${name}-actual.png`);
        const expected = att(`${name}-expected.png`);
        const diff = att(`${name}-diff.png`);
        const shot = att(`visual-shot-${name}.png`);
        const actualBuf = actual ? body(actual) : shot ? body(shot) : undefined;
        const base = {
          name,
          region,
          persona,
          viewport,
          maxDiffPixelRatio: i.ratioFor(region),
          environment: i.environment,
        };
        const trust = trustBaseline(i.folder, i.manifest, name, i.release);
        const baselineFile = baselineImage(i.folder, name);
        const images = {
          ...(existsSync(baselineFile) ? { baseline: save(name, 'baseline', readFileSync(baselineFile)) } : {}),
          ...(actualBuf ? { actual: save(name, 'actual', actualBuf) } : {}),
          ...(diff ? { diff: save(name, 'diff', body(diff)) } : {}),
        };
        const actualSha = actualBuf ? { actualSha256: sha256Buffer(actualBuf) } : {};
        const err = errors.find((e) => e.includes(`${name}.png`));
        const noSnapshot = err !== undefined && /snapshot doesn't exist/i.test(err);
        if ((actual && !expected) || noSnapshot) {
          out.candidates.push(
            VisualCandidate.parse({
              ...base,
              status: 'NO_BASELINE',
              images,
              ...actualSha,
              reason: 'no approved baseline yet — the actual image is the proposal',
            }),
          );
        } else if (actual || err) {
          const r = err ? RATIO.exec(err) : null;
          // Playwright rounds the ratio to 2 decimals in its message; compute it from the pixel count and image size.
          const size = actualBuf ? pngSize(actualBuf) : undefined;
          const ratio = r ? (size ? Number(r[1]) / (size.width * size.height) : Number(r[2])) : undefined;
          out.candidates.push(
            VisualCandidate.parse({
              ...base,
              status: 'DIFF',
              images,
              ...actualSha,
              ...(r && ratio !== undefined ? { diffPixels: Number(r[1]), diffPixelRatio: Math.min(1, ratio) } : {}),
              reason: r
                ? `${r[1] ?? '?'} pixels differ (${((ratio ?? 0) * 100).toFixed(3)} % > allowed ${(base.maxDiffPixelRatio * 100).toFixed(3)} %)`
                : (err
                    ?.split('\n')
                    .find((l) => /different|size|Expected an image/i.test(l))
                    ?.trim() ?? 'differs from the baseline'),
            }),
          );
        } else if (layout || shot) {
          out.candidates.push(
            VisualCandidate.parse(
              trust.ok
                ? {
                    ...base,
                    status: 'MATCH',
                    images,
                    ...actualSha,
                    reason: `matches the baseline approved ${trust.record.approvedAt} (${trust.record.approvalId})`,
                  }
                : { ...base, status: 'RE_APPROVE', images, ...actualSha, reason: trust.reason },
            ),
          );
        } else {
          out.candidates.push(
            VisualCandidate.parse({
              ...base,
              status: 'NOT_CAPTURED',
              images,
              reason: `region not captured: ${errors[0]?.split('\n')[0] ?? `test ${last.status ?? 'did not finish'}`}`,
            }),
          );
        }
      }
    }
  }
  return out;
}

/** Copy an approved actual image from the run folder into the baseline folder. */
export function copyImage(from: string, to: string): void {
  mkdirSync(join(to, '..'), { recursive: true });
  copyFileSync(from, to);
}
