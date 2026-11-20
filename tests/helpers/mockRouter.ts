import { ModelsConfig } from '../../src/config/schemas.js';
import type { MockOptions } from '../../src/models/mock.js';
import { ModelRouter, type MockKey } from '../../src/models/router.js';

export const TEST_SECRET = 'AIzaSy-test-secret-value-123';

/** Router where every role is the mock provider; `reasoning` has a mock fallback. */
export async function mockRouter(
  mock: Partial<Record<MockKey, MockOptions>> = {},
  secretValues: readonly string[] = [TEST_SECRET],
): Promise<ModelRouter> {
  return ModelRouter.create({
    config: ModelsConfig.parse({
      roles: {
        reasoning: { provider: 'mock', model: 'mock-pro', fallback: { provider: 'mock', model: 'mock-flash' } },
        coder: { provider: 'mock', model: 'mock-flash' },
        fast: { provider: 'mock', model: 'mock-lite' },
        judge: { provider: 'mock', model: 'mock-pro' },
      },
      embeddings: { provider: 'mock', model: 'mock-embed' },
      budgets: { tokensPerRun: 1_000_000, minutesPerRun: 10 },
    }),
    secrets: { get: () => Promise.resolve(undefined), setting: () => undefined },
    secretValues: () => secretValues,
    mock,
  });
}
