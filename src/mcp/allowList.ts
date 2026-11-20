import type { McpToolsConfig } from '../config/schemas.js';

export type ToolClass = 'observe' | 'mutate' | 'blocked' | 'unlisted';

const isPlaceholder = (s: string): boolean => /<[^<>]+>/.test(s);

/**
 * MCP tool allow-list (PLAN.md §7d, config/mcp-tools.yaml). Only `observe` and `mutate` tools are ever exposed;
 * `blocked` and anything not listed are refused. Placeholder entries (`<…>`) classify nothing.
 */
export class ToolAllowList {
  constructor(private readonly config: McpToolsConfig) {}

  classify(server: string, tool: string): ToolClass {
    const s = this.config[server];
    if (!s) return 'unlisted';
    if (s.blocked.includes(tool)) return 'blocked';
    if (s.mutate.includes(tool)) return 'mutate';
    if (s.observe.includes(tool)) return 'observe';
    return 'unlisted';
  }

  isAllowed(server: string, tool: string): boolean {
    const c = this.classify(server, tool);
    return c === 'observe' || c === 'mutate';
  }

  /** Real tool names a server offers that the allow-list does not classify yet (reported by doctor). */
  unclassified(server: string, tools: readonly string[]): string[] {
    return tools.filter((t) => this.classify(server, t) === 'unlisted');
  }

  /** Placeholder entries still present for a server. */
  placeholders(server: string): string[] {
    const s = this.config[server];
    if (!s) return [];
    return [...s.observe, ...s.mutate, ...s.blocked].filter(isPlaceholder);
  }

  /** Allow-list entries that the server does not actually offer (stale names). */
  stale(server: string, tools: readonly string[]): string[] {
    const s = this.config[server];
    if (!s) return [];
    const have = new Set(tools);
    return [...s.observe, ...s.mutate].filter((t) => !isPlaceholder(t) && !have.has(t));
  }
}
