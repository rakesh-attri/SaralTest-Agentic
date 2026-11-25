import { format, resolveConfig } from 'prettier';

/** Format generated TypeScript with the repo's Prettier config, so generated files pass `format:check`. */
export async function formatTypeScript(text: string, filePath: string): Promise<string> {
  const config = (await resolveConfig(filePath)) ?? {};
  return format(text, { ...config, filepath: filePath, parser: 'typescript' });
}
