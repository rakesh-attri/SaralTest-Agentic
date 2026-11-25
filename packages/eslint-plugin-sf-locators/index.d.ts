import type { ESLint, Rule } from 'eslint';

/** Banned selector fragments: [pattern, reason]. Shared with the locator registry checks. */
export declare const BANNED_SELECTOR_PATTERNS: ReadonlyArray<readonly [RegExp, string]>;
/** Returns the first reason a selector / URL string is fragile, or undefined. */
export declare function fragileReason(text: string, isUrl?: boolean): string | undefined;
export declare const noFragileLocators: Rule.RuleModule;
declare const plugin: ESLint.Plugin & { rules: { 'no-fragile-locators': Rule.RuleModule } };
export default plugin;
