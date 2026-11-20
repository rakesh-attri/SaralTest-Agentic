import { z } from 'zod';

/** ISO-8601 timestamp string. */
export const IsoDate = z.iso.datetime({ offset: true });

/** Exact 18-character Salesforce Organization ID (PLAN.md §7b). */
export const OrgId18 = z.string().regex(/^00D[a-zA-Z0-9]{15}$/, 'must be an 18-character Org ID starting with 00D');

/** Where a result came from. Non-LIVE results are never reported as a real Salesforce pass (CLAUDE.md rule 13). */
export const Environment = z.enum(['LIVE', 'FIXTURE', 'MOCK']);
export type Environment = z.infer<typeof Environment>;

export const Risk = z.enum(['HIGH', 'MEDIUM', 'LOW']);
export const Priority = z.enum(['P0', 'P1', 'P2', 'P3']);
export const Severity = z.enum(['CRITICAL', 'MAJOR', 'MINOR', 'TRIVIAL']);
