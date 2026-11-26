// Browser channel switch (PLAN.md §7b): `--browser` > QA_BROWSER > config/execution.yaml `browser`. chrome / msedge
// are local installs (Playwright `channel`); when the requested one is not installed, `fallbackBrowser` is used and
// the substitution is recorded in every result — never silent.
import { Browser } from '../core/schemas/execution.js';
import { QAError } from '../core/errors.js';

export interface BrowserChoice {
  /** Browser the tests run in. */
  browser: Browser;
  /** What was asked for (differs from `browser` only when a fallback was used). */
  requested: Browser;
  /** Where the request came from. */
  source: 'option' | 'env' | 'config';
  /** Set when the requested channel was missing and the fallback was used. */
  fallbackReason?: string;
}

/** Probe: can Playwright launch this browser? (chromium = bundled; chrome / msedge = installed channel). */
export type BrowserProbe = (b: Browser) => Promise<{ ok: boolean; error?: string }>;

export const playwrightProbe: BrowserProbe = async (b) => {
  const { chromium } = await import('@playwright/test');
  try {
    const br = await chromium.launch({ headless: true, ...(b === 'chromium' ? {} : { channel: b }) });
    await br.close();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.split('\n')[0] ?? msg };
  }
};

/** Playwright `use.channel` for a browser (undefined = bundled Chromium). */
export const channelOf = (b: Browser): string | undefined => (b === 'chromium' ? undefined : b);

export async function resolveBrowser(o: {
  option?: string;
  env?: string;
  configured: string;
  fallback?: string;
  probe: BrowserProbe;
}): Promise<BrowserChoice> {
  const source: BrowserChoice['source'] = o.option ? 'option' : o.env ? 'env' : 'config';
  const raw = o.option ?? o.env ?? o.configured;
  const parsed = Browser.safeParse(raw);
  if (!parsed.success) {
    throw new QAError('ENVIRONMENT', `unknown browser "${raw}" (${source}); use chromium, chrome or msedge`);
  }
  const requested = parsed.data;
  const first = await o.probe(requested);
  if (first.ok) return { browser: requested, requested, source };
  const fb = Browser.safeParse(o.fallback);
  const candidates = [fb.success ? fb.data : undefined, 'chromium' as const].filter(
    (x): x is Browser => x !== undefined && x !== requested,
  );
  for (const c of candidates) {
    const p = await o.probe(c);
    if (p.ok) {
      return {
        browser: c,
        requested,
        source,
        fallbackReason: `${requested} could not be launched (${first.error ?? 'not installed'}); ran on ${c} instead`,
      };
    }
  }
  throw new QAError('ENVIRONMENT', `browser ${requested} could not be launched: ${first.error ?? 'not installed'}`, {
    fix:
      requested === 'chromium' ? 'npx playwright install chromium' : `install ${requested} or use --browser chromium`,
  });
}
