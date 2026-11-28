// Known browser-console noise (config/console-noise.yaml): Salesforce-owned messages a human reviewed and accepted.
// The Explorer does not report a matching message as a finding; it counts it per entry in the coverage note.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const ConsoleNoiseEntry = z.object({
  id: z.string().regex(/^CN-\d{3,}$/),
  /** Org aliases the entry applies to. */
  orgs: z.array(z.string().min(1)).min(1),
  /** Only Salesforce-owned messages may be accepted as noise. */
  owner: z.literal('salesforce'),
  /** Case-sensitive substring of the console message (at least a sentence, never a catch-all). */
  contains: z.string().min(20),
  reason: z.string().min(5),
  acceptedBy: z.string().min(2),
  acceptedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  source: z.string().min(3),
});
export type ConsoleNoiseEntry = z.infer<typeof ConsoleNoiseEntry>;

export const ConsoleNoiseFile = z.object({ entries: z.array(ConsoleNoiseEntry).default([]) });

export const consoleNoiseFile = (root: string): string => join(root, 'config', 'console-noise.yaml');

/** Entries for one org (missing file → none). An invalid file is an error: noise must never be accepted by accident. */
export function loadConsoleNoise(root: string, orgAlias: string): ConsoleNoiseEntry[] {
  const f = consoleNoiseFile(root);
  if (!existsSync(f)) return [];
  const doc = ConsoleNoiseFile.parse(parse(readFileSync(f, 'utf8')) ?? {});
  const ids = doc.entries.map((e) => e.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`config/console-noise.yaml: duplicate id ${dup}`);
  return doc.entries.filter((e) => e.orgs.includes(orgAlias));
}

/** The accepted entry a console message matches, if any. */
export function matchConsoleNoise(
  entries: readonly ConsoleNoiseEntry[],
  message: string,
): ConsoleNoiseEntry | undefined {
  return entries.find((e) => message.includes(e.contains));
}
