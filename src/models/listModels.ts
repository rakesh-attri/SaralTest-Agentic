import { z } from 'zod';
import { QAError } from '../core/errors.js';
import type { ChatProvider } from '../config/schemas.js';
import type { ProviderSecrets } from './providers/index.js';

export interface AvailableModel {
  id: string;
  displayName?: string;
  /** e.g. generateContent, embedContent (Google) */
  methods: string[];
}

const GoogleModels = z.object({
  models: z
    .array(
      z.looseObject({
        name: z.string(),
        displayName: z.string().optional(),
        supportedGenerationMethods: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  nextPageToken: z.string().optional(),
});
const IdList = z.object({ data: z.array(z.looseObject({ id: z.string() })).default([]) });
const OllamaTags = z.object({ models: z.array(z.looseObject({ name: z.string() })).default([]) });

async function getJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw Object.assign(new Error(`GET ${new URL(url).host} → HTTP ${res.status}`), { status: res.status });
  return res.json();
}

/**
 * List models the configured key can use. Read-only metadata endpoints; keys go in headers, never in URLs.
 * Used by `qa doctor` to suggest real model IDs instead of guessing.
 */
export async function listAvailableModels(
  provider: ChatProvider,
  secrets: ProviderSecrets,
  timeoutMs = 15_000,
  fetchImpl: typeof fetch = fetch,
): Promise<AvailableModel[]> {
  switch (provider) {
    case 'google': {
      const key = await secrets.get('GOOGLE_API_KEY');
      if (!key) throw new QAError('TOOL_UNAVAILABLE', 'GOOGLE_API_KEY is not set');
      const out: AvailableModel[] = [];
      let pageToken: string | undefined;
      do {
        const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
        url.searchParams.set('pageSize', '1000');
        if (pageToken) url.searchParams.set('pageToken', pageToken);
        const page = GoogleModels.parse(await getJson(url.toString(), { 'x-goog-api-key': key }, timeoutMs, fetchImpl));
        for (const m of page.models) {
          out.push({
            id: m.name.replace(/^models\//, ''),
            ...(m.displayName ? { displayName: m.displayName } : {}),
            methods: m.supportedGenerationMethods,
          });
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
      return out;
    }
    case 'anthropic': {
      const key = await secrets.get('ANTHROPIC_API_KEY');
      if (!key) throw new QAError('TOOL_UNAVAILABLE', 'ANTHROPIC_API_KEY is not set');
      const body = IdList.parse(
        await getJson(
          'https://api.anthropic.com/v1/models?limit=1000',
          { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          timeoutMs,
          fetchImpl,
        ),
      );
      return body.data.map((m) => ({ id: m.id, methods: ['messages'] }));
    }
    case 'openai': {
      const key = await secrets.get('OPENAI_API_KEY');
      if (!key) throw new QAError('TOOL_UNAVAILABLE', 'OPENAI_API_KEY is not set');
      const body = IdList.parse(
        await getJson('https://api.openai.com/v1/models', { authorization: `Bearer ${key}` }, timeoutMs, fetchImpl),
      );
      return body.data.map((m) => ({ id: m.id, methods: [] }));
    }
    case 'ollama': {
      const base = secrets.setting('OLLAMA_BASE_URL') ?? 'http://localhost:11434';
      const body = OllamaTags.parse(await getJson(`${base.replace(/\/$/, '')}/api/tags`, {}, timeoutMs, fetchImpl));
      return body.models.map((m) => ({ id: m.name, methods: ['chat'] }));
    }
    case 'azure-openai':
      throw new QAError('TOOL_UNAVAILABLE', 'azure-openai deployments are not listable with an API key');
    case 'mock':
      return [{ id: 'mock', methods: ['generateContent', 'embedContent'] }];
  }
}

export interface ModelSuggestion {
  reasoning?: string;
  coder?: string;
  fast?: string;
  judge?: string;
  embeddings?: string;
  /** Newer preview/experimental ids that were passed over in favour of a stable one (for the operator to weigh). */
  newerPreview?: { pro?: string; flash?: string; lite?: string };
}

/** Compare version-ish ids so newer families sort first (gemini-3.1 > gemini-3 > gemini-2.5). */
function versionKey(id: string): number[] {
  return (id.match(/\d+(\.\d+)?/g) ?? []).map(Number);
}
function newerFirst(a: string, b: string): number {
  const va = versionKey(a);
  const vb = versionKey(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] ?? 0) - (va[i] ?? 0);
    if (d) return d;
  }
  return a.localeCompare(b);
}

/**
 * Suggest Gemini IDs per role from what the key can actually use. Stable models are preferred over
 * preview/experimental ones. These are suggestions for the operator to confirm — never written automatically.
 */
export function suggestGeminiModels(models: readonly AvailableModel[]): ModelSuggestion {
  const unstable = /preview|exp|experimental|latest|tts|image|audio|live|thinking|computer|robotics|vision|native/i;
  const chat = models.filter((m) => m.methods.includes('generateContent') && /^gemini-/i.test(m.id));
  const previews: { pro?: string; flash?: string; lite?: string } = {};
  const pick = (slot: 'pro' | 'flash' | 'lite', re: RegExp, exclude?: RegExp): string | undefined => {
    const pool = chat.filter((m) => re.test(m.id) && !(exclude?.test(m.id) ?? false));
    const stable = pool.filter((m) => !unstable.test(m.id)).map((m) => m.id);
    // Plain "-preview" ids of the same family (tts/image/live/customtools… stay excluded).
    const preview = pool
      .map((m) => m.id)
      .filter((id) => id.endsWith('-preview') && !unstable.test(id.slice(0, -'-preview'.length)));
    const chosen = [...stable].sort(newerFirst)[0] ?? [...preview].sort(newerFirst)[0];
    const newestPreview = [...preview].sort(newerFirst)[0];
    if (chosen && newestPreview && newestPreview !== chosen && newerFirst(newestPreview, chosen) < 0) {
      previews[slot] = newestPreview;
    }
    return chosen;
  };
  const pro = pick('pro', /-pro\b/);
  const flash = pick('flash', /-flash\b/, /lite/);
  const lite = pick('lite', /flash-lite/);
  const embedIds = models.filter((m) => m.methods.includes('embedContent') && /embedding/i.test(m.id)).map((m) => m.id);
  // Prefer the Gemini embedding family over legacy text-embedding-* ids.
  const embed =
    [...embedIds.filter((id) => /^gemini-/i.test(id))].sort(newerFirst)[0] ?? [...embedIds].sort(newerFirst)[0];
  return {
    ...(pro ? { reasoning: pro, judge: pro } : {}),
    ...(flash ? { coder: flash } : {}),
    ...(lite ? { fast: lite } : flash ? { fast: flash } : {}),
    ...(embed ? { embeddings: embed } : {}),
    ...(Object.keys(previews).length ? { newerPreview: previews } : {}),
  };
}
