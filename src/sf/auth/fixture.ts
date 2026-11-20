import { QAError } from '../../core/errors.js';
import type { Seed } from '../../fixture/store.js';
import type { SessionProvider, SessionRequest, SfSession } from './types.js';

/**
 * Sessions for the offline fixture (examples/fixture). Personas map to seed users by persona id. Everything obtained
 * here is FIXTURE, never live Salesforce evidence (CLAUDE.md rule 13).
 */
export class FixtureSessionProvider implements SessionProvider {
  readonly kind = 'fixture' as const;

  constructor(
    private readonly seed: Pick<Seed, 'organization' | 'users'>,
    private readonly apiVersion = '62.0',
  ) {}

  private user(req: SessionRequest): Seed['users'][number] {
    const user = this.seed.users.find((u) => u.persona === req.persona.id);
    if (!user) {
      throw new QAError('AUTH', `fixture has no user for persona ${req.persona.id}`, { persona: req.persona.id });
    }
    return user;
  }

  session(req: SessionRequest): Promise<SfSession> {
    if (req.org.environment !== 'FIXTURE') {
      return Promise.reject(new QAError('AUTH', `fixture sessions only work for FIXTURE orgs (${req.org.alias})`));
    }
    const user = this.user(req);
    return Promise.resolve({
      orgAlias: req.org.alias,
      personaId: req.persona.id,
      username: user.Username,
      orgId: this.seed.organization.Id,
      instanceUrl: req.org.instanceUrl.replace(/\/+$/, ''),
      accessToken: user.token,
      apiVersion: this.apiVersion,
      source: 'fixture',
      obtainedAt: Date.now(),
    });
  }

  async frontdoorUrl(req: SessionRequest, path = '/lightning/page/home'): Promise<string> {
    const s = await this.session(req);
    return `${s.instanceUrl}/secur/frontdoor.jsp?sid=${encodeURIComponent(s.accessToken)}&retURL=${encodeURIComponent(path)}`;
  }
}
