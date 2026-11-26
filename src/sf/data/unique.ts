// Run-unique test values that fit their field (operator rule 2026-11-26 (1)).
/**
 * `<prefix>-<label>-<token>` within `maxLength` (run-p5-live-5, TC-026: a 41-character First Name was cut to the
 * field's 40 by Salesforce). The label is shortened first, then dropped; the random token always stays (uniqueness).
 */
export function fitUnique(prefix: string, label: string, token: string, maxLength?: number): string {
  const full = `${prefix}-${label}-${token}`;
  if (maxLength === undefined || full.length <= maxLength) return full;
  const room = maxLength - prefix.length - token.length - 2;
  const short = label.slice(0, Math.max(0, room)).replace(/-+$/, '');
  if (short) return `${prefix}-${short}-${token}`;
  const bare = `${prefix}-${token}`;
  if (bare.length <= maxLength) return bare;
  return maxLength > token.length + 1 ? `${prefix.slice(0, maxLength - token.length - 1)}-${token}` : token;
}
