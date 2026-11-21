// Test Generator (PLAN.md §3, design squad, role `coder`): APPROVED test cases → test IR (model, Zod-validated,
// deterministic checks reflected back) → Playwright spec rendered by code. Degrade: a `test.fixme` skeleton marked
// mechanical. Page objects come from the locator registry (pageObjects.ts), never from the model.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Logger } from 'pino';
import { QAError } from '../../core/errors.js';
import { TestIR, type GeneratedArtifact } from '../../core/schemas/generation.js';
import type { TestCase } from '../../core/schemas/testCase.js';
import type { ModelRouter } from '../../models/router.js';
import type { Redactor } from '../../security/redact.js';
import type { SkillLoader } from '../../skills/skillLoader.js';
import { runStructured } from '../shared/structured.js';
import { bindRecipe, irProblems, type GenerationContext, type RecipeView } from './context.js';
import { hashText } from './pageObjects.js';
import { locatorsUsed, renderSkeleton, renderSpec, specPath } from './render.js';

export const TEST_GENERATOR_SKILLS = [
  'playwright-standards',
  'salesforce-lightning-locators',
  'salesforce-api-testing',
] as const;

function loadPrompts(): Record<string, string> {
  const text = readFileSync(new URL('./prompt.md', import.meta.url), 'utf8');
  const out: Record<string, string> = {};
  for (const part of text.split(/^## /m).slice(1)) {
    const nl = part.indexOf('\n');
    out[part.slice(0, nl).trim()] = part.slice(nl + 1).trim();
  }
  return out;
}
const fill = (tpl: string, vars: Record<string, string>): string =>
  tpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');

export interface GeneratorDeps {
  router?: ModelRouter;
  skills?: SkillLoader;
  redactor?: Redactor;
  logger?: Logger;
}

export interface GeneratedSpec {
  caseId: string;
  path: string;
  text: string;
  artifact: GeneratedArtifact;
  ir?: TestIR;
  /** Deterministic problems left after the model's last attempt (empty for an accepted IR). */
  problems: string[];
  model: string;
  degradedReason?: string;
}

export interface GenerateResult {
  specs: GeneratedSpec[];
  environment: 'LIVE' | 'MOCK' | 'NONE';
  models: string[];
  degraded: { caseId: string; reason: string }[];
}

/** Stable hash of the parts of a case a test depends on (lineage: spec ↔ case version). */
export function caseHash(tc: TestCase): string {
  const { id, title, type, persona, priority, severity, preconditions, steps, tags, requirementIds, snapshotId } = tc;
  return hashText(
    JSON.stringify({
      id,
      title,
      type,
      persona,
      priority,
      severity,
      preconditions,
      steps,
      tags,
      requirementIds,
      snapshotId,
    }),
  );
}

function catalogText(ctx: GenerationContext): string {
  return ctx.catalog.pages
    .map(
      (p) =>
        `${p.className} (${p.id}, ${p.kind}${p.kind === 'record' ? `, object ${p.object}` : ''}):\n` +
        p.members
          .map(
            (m) =>
              `  ${m.ref} · ${m.role ?? m.kind} "${m.accessibleName ?? ''}"${m.fieldApiName ? ` · ${m.fieldApiName}` : ''}${m.scopeName ? ` · in "${m.scopeName}"` : ''}${m.status === 'RE_VERIFY' ? ' · RE_VERIFY' : ''}`,
          )
          .join('\n'),
    )
    .join('\n');
}

function factsText(ctx: GenerationContext, recipe: RecipeView | undefined): string {
  const objects = [
    ...new Set([...(recipe?.plan.steps.map((s) => s.object) ?? []), ...ctx.catalog.pages.map((p) => p.object)]),
  ];
  const lines: string[] = [];
  for (const o of objects) {
    const fields = new Set<string>([
      ...(recipe?.plan.steps.filter((s) => s.object === o).flatMap((s) => Object.keys(s.fields)) ?? []),
      ...ctx.catalog.pages
        .flatMap((p) => p.members.map((m) => m.fieldApiName))
        .filter((f): f is string => f?.startsWith(`${o}.`) === true)
        .map((f) => f.split('.')[1] ?? ''),
    ]);
    for (const f of [...fields].sort()) {
      const fact = ctx.facts.field(o, f);
      if (fact)
        lines.push(
          `${o}.${f} · ${fact.type}${fact.length ? ` · ${fact.length}` : ''}${fact.required ? ' · required' : ''}`,
        );
    }
    for (const vr of ctx.facts.activeValidationRules(o)) {
      const text = (k: string): string => {
        const v = vr.body?.[k];
        return typeof v === 'string' ? v : '';
      };
      lines.push(`${o} rule ${vr.apiName}: "${text('errorMessage')}" when ${text('errorConditionFormula')}`);
    }
  }
  return lines.join('\n');
}

function recipeText(recipe: RecipeView | undefined): string {
  if (!recipe) return '(no approved recipe covers this case: do not create data)';
  return recipe.plan.steps
    .map(
      (s) =>
        `${s.stepId} (${s.object}${s.parent ? `, ${s.parent.field} → ${s.parent.stepId}` : ''}): ${Object.entries(
          s.fields,
        )
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(', ')}`,
    )
    .join('\n');
}

/** Generate one spec per APPROVED case. Cases that are not APPROVED are never generated (Phase 3 decided). */
export async function generateTests(
  ctx: GenerationContext,
  cases: readonly TestCase[],
  deps: GeneratorDeps,
  mode: 'llm' | 'mechanical',
  /** Pass-2 findings to reflect into a regeneration, per case id. */
  feedback: Record<string, string[]> = {},
): Promise<GenerateResult> {
  const prompts = loadPrompts();
  const specs: GeneratedSpec[] = [];
  const degraded: GenerateResult['degraded'] = [];
  const models = new Set<string>();
  const envs = new Set<'LIVE' | 'MOCK'>();

  for (const tc of cases.filter((c) => c.reviewStatus === 'APPROVED')) {
    const recipe = bindRecipe(tc, ctx);
    const ch = caseHash(tc);
    const path = specPath(ctx.storyKey, tc);
    const skeleton = (reason: string): void => {
      const text = renderSkeleton(tc, ctx, reason, ch);
      degraded.push({ caseId: tc.id, reason });
      specs.push({
        caseId: tc.id,
        path,
        text,
        problems: [reason],
        model: 'mechanical',
        degradedReason: reason,
        artifact: {
          kind: 'spec',
          path,
          hash: hashText(text),
          testCaseIds: [tc.id],
          caseHash: ch,
          snapshotId: tc.snapshotId,
          locatorsUsed: [],
          dataBindings: [],
          origin: 'mechanical',
          reviewReasons: [`mechanical skeleton: ${reason}`],
        },
      });
    };
    if (mode === 'mechanical' || !deps.router) {
      skeleton('no model available (offline / degraded)');
      continue;
    }
    const prior = feedback[tc.id] ?? [];
    try {
      const r = await runStructured({
        router: deps.router,
        role: 'coder',
        agent: 'test-generator',
        schema: TestIR,
        system: fill(prompts['generate'] ?? '', { storyKey: ctx.storyKey, recipe: recipe?.name ?? 'none' }),
        user:
          fill(prompts['user'] ?? '', {
            case: JSON.stringify(
              {
                id: tc.id,
                title: tc.title,
                type: tc.type,
                persona: tc.persona,
                preconditions: tc.preconditions,
                steps: tc.steps.map((s, i) => ({ caseStep: i, action: s.action, expected: s.expected })),
              },
              null,
              1,
            ),
            recipeSteps: recipeText(recipe),
            catalog: catalogText(ctx),
            facts: factsText(ctx, recipe),
            caseId: tc.id,
          }) +
          (prior.length
            ? `\n\nReviewer findings on your previous test for this case (fix them):\n- ${prior.join('\n- ')}`
            : ''),
        ...(deps.skills ? { skills: { loader: deps.skills, names: TEST_GENERATOR_SKILLS } } : {}),
        check: (ir) => irProblems(tc, ir, ctx, recipe),
        ...(deps.redactor ? { redactor: deps.redactor } : {}),
        ...(deps.logger ? { logger: deps.logger } : {}),
      });
      models.add(`generator=${r.model}${r.usedFallback ? ' (fallback)' : ''}`);
      envs.add(r.environment);
      const ir = r.value;
      const irHash = hashText(JSON.stringify(ir));
      const text = renderSpec({ tc, ir, ctx, recipe, caseHash: ch, irHash, model: r.model });
      specs.push({
        caseId: tc.id,
        path,
        text,
        ir,
        problems: [],
        model: r.model,
        artifact: {
          kind: 'spec',
          path,
          hash: hashText(text),
          testCaseIds: [tc.id],
          caseHash: ch,
          irHash,
          snapshotId: tc.snapshotId,
          locatorsUsed: locatorsUsed(ir, ctx.catalog, recipe),
          dataBindings: recipe && ir.data.length ? [recipe.name] : [],
          origin: 'generated',
          reviewReasons: [],
        },
      });
    } catch (e) {
      if (!(e instanceof QAError) || (e.kind !== 'INVALID_LLM_OUTPUT' && e.kind !== 'TOOL_UNAVAILABLE')) throw e;
      skeleton(`${e.kind}: ${e.message}`);
    }
  }
  const environment = envs.has('MOCK') ? 'MOCK' : envs.has('LIVE') ? 'LIVE' : 'NONE';
  return { specs, environment, models: [...models], degraded };
}

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
