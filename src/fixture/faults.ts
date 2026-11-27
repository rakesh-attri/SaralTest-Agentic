// Fault injection for the offline fixture (Phase 7, `qa fixture serve --faults <file>`). Each fault reproduces one
// failure class the Failure Investigator must tell apart. FIXTURE only — nothing here touches a real org.
//   labelRenames      → SCRIPT_LOCATOR  (a button / field label changed; the element still exists)
//   toastDelayMs      → SCRIPT_TIMING   (the success toast appears later than the helper waits)
//   behaviour.blockContactDeleteWithOpenCases = false (default, as qa-prod) → PRODUCT_DEFECT for BR-08
//   disableRules      → PRODUCT_DEFECT  (an approved validation rule stops being enforced)
//   extraRules        → TEST_DATA       (a new org rule the approved data recipe violates)
//   unavailablePaths  → ENVIRONMENT     (Lightning pages answer 503 / maintenance)
//   readOnlyObjects   → PERMISSION_CONFIG (the persona loses create / edit on an object)
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { FixtureRule } from './store.js';

export const FixtureBehaviour = z.object({
  /** BR-08 as the product would implement it. qa-prod deliberately does not (operator 2026-11-27): default false. */
  blockContactDeleteWithOpenCases: z.boolean().default(false),
});
export type FixtureBehaviour = z.infer<typeof FixtureBehaviour>;

export const FixtureFaults = z.object({
  id: z.string().optional(),
  labelRenames: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).default([]),
  toastDelayMs: z.number().int().nonnegative().max(120_000).default(0),
  disableRules: z.array(z.string()).default([]),
  extraRules: z
    .array(
      z.object({
        object: z.string(),
        name: z.string(),
        formula: z.string(),
        message: z.string(),
        field: z.string().optional(),
      }),
    )
    .default([]),
  /** Regex sources matched against the request path; matching requests answer 503 (HTML maintenance page / JSON). */
  unavailablePaths: z.array(z.string()).default([]),
  /** Objects every persona may read but not create / edit / delete (403 INSUFFICIENT_ACCESS_OR_READONLY). */
  readOnlyObjects: z.array(z.string()).default([]),
  behaviour: FixtureBehaviour.prefault({}),
});
export type FixtureFaults = z.infer<typeof FixtureFaults>;

export const NO_FAULTS: FixtureFaults = FixtureFaults.parse({});

export function loadFixtureFaults(file: string): FixtureFaults {
  const text = readFileSync(file, 'utf8');
  return FixtureFaults.parse(file.endsWith('.json') ? JSON.parse(text) : parse(text));
}

const escRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Apply label renames to a page template: button text and aria-labels (the accessible names Playwright sees). */
export function applyLabelRenames(html: string, renames: FixtureFaults['labelRenames']): string {
  let out = html;
  for (const r of renames) {
    out = out
      .replace(new RegExp(`(<button\\b[^>]*>)\\s*${escRe(r.from)}\\s*(</button>)`, 'g'), `$1${r.to}$2`)
      .replace(new RegExp(`(<label\\b[^>]*>)\\s*${escRe(r.from)}\\s*(</label>)`, 'g'), `$1${r.to}$2`)
      .replace(new RegExp(`aria-label="${escRe(r.from)}"`, 'g'), `aria-label="${r.to}"`);
  }
  return out;
}

/** Enforced rules after the fault: disabled ones removed, extra ones added. */
export function applyRuleFaults(rules: readonly FixtureRule[], f: FixtureFaults): FixtureRule[] {
  const off = new Set(f.disableRules.map((n) => n.toLowerCase()));
  return [
    ...rules.filter((r) => !off.has(r.name.toLowerCase()) && !off.has(`${r.object}.${r.name}`.toLowerCase())),
    ...f.extraRules.map((r) => ({ ...r })),
  ];
}

export const isUnavailable = (path: string, f: FixtureFaults): boolean =>
  f.unavailablePaths.some((src) => new RegExp(src).test(path));

export const isReadOnly = (object: string, f: FixtureFaults): boolean =>
  f.readOnlyObjects.some((o) => o.toLowerCase() === object.toLowerCase());

/** Script the page reads (window.__fixtureFaults) — timing only; never data. */
export function pageFaultScript(f: FixtureFaults): string {
  return `<script>window.__fixtureFaults = ${JSON.stringify({ toastDelayMs: f.toastDelayMs })};</script>`;
}

export const MAINTENANCE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Service Unavailable (OFFLINE FIXTURE)</title></head>
<body data-qa-environment="FIXTURE">
<main><h1>Service Unavailable</h1><p>The server is temporarily unable to service your request due to maintenance downtime or capacity problems. Please try again later.</p></main>
</body></html>`;
