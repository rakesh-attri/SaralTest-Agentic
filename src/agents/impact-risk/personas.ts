import type { OrgCheck } from '../sf-intelligence/schema.js';

export interface ConfiguredPersona {
  id: string;
  profile: string;
}

export interface ResolvedPersona {
  /** Configured persona id when available, else a kebab-case slug of the requirement's name. */
  id: string;
  /** Name as the requirements use it ("Read Only User"). */
  name: string;
  /** Org profile it maps to, when known. */
  profile?: string;
  available: boolean;
  note: string;
}

export const slug = (t: string): string =>
  t
    .toLowerCase()
    .replace(/\buser\b/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * Map a persona named in requirements to a configured test user (personas.yaml). The org cross-check tells which
 * profile a name maps to ("Read Only User" → Profile "Read Only"); a persona without a configured test user is
 * unavailable, and its cases are BLOCKED-NO-PERSONA (never run as someone else).
 */
export function resolvePersona(
  name: string,
  configured: readonly ConfiguredPersona[],
  checks: readonly OrgCheck[] = [],
): ResolvedPersona {
  const n = name.trim();
  const lc = n.toLowerCase();
  const direct = configured.find(
    (p) => p.id.toLowerCase() === lc || p.profile.toLowerCase() === lc || p.id === slug(n),
  );
  if (direct) return { id: direct.id, name: n, profile: direct.profile, available: true, note: 'configured test user' };
  const check = checks.find((c) => c.check === 'persona' && c.subject.toLowerCase().includes(`"${lc}"`));
  const profile =
    check?.result === 'EXISTS' ? check.evidence.find((e) => e.componentType === 'Profile')?.apiName : undefined;
  if (profile) {
    const byProfile = configured.find((p) => p.profile.toLowerCase() === profile.toLowerCase());
    if (byProfile) {
      return {
        id: byProfile.id,
        name: n,
        profile,
        available: true,
        note: `maps to profile ${profile} (${check?.id ?? ''})`,
      };
    }
    return {
      id: slug(profile),
      name: n,
      profile,
      available: false,
      note: `profile ${profile} exists (${check?.id ?? ''}) but no test user is configured in personas.yaml`,
    };
  }
  return {
    id: slug(n),
    name: n,
    available: false,
    note: check
      ? `no profile or permission set for "${n}" in the org (${check.id})`
      : `no configured test user for "${n}"`,
  };
}
