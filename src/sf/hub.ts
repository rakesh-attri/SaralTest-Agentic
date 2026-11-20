import type { OrgsConfig, McpToolsConfig } from '../config/schemas.js';
import type { Logger } from '../core/logger.js';
import { ToolAllowList } from '../mcp/allowList.js';
import { loadMcpJson, McpHub, type TransportFactory } from '../mcp/client.js';
import type { AuditLog } from '../security/audit.js';
import { createOrgPolicyGuard } from '../security/orgPolicy.js';
import type { Redactor } from '../security/redact.js';
import type { IdentityRegistry } from './client.js';

export interface SalesforceHubOptions {
  root: string;
  orgs: OrgsConfig;
  mcpTools: McpToolsConfig;
  registry: IdentityRegistry;
  redactor: Redactor;
  audit?: AuditLog;
  logger?: Logger;
  hasApproval?: (approvalId: string | undefined) => boolean;
  transportFactory?: TransportFactory;
}

/**
 * Salesforce DX MCP hub with the org-profile guard wired in (replaces Phase 0's deny-all default). Only the
 * `salesforce` server from .mcp.json is exposed; observe tools pass the allow-list, mutate tools pass the guard.
 */
export async function createSalesforceHub(o: SalesforceHubOptions): Promise<McpHub | undefined> {
  const mcp = await loadMcpJson(o.root).catch(() => undefined);
  const server = mcp?.mcpServers['salesforce'];
  if (!server) return undefined;
  return new McpHub({
    servers: { salesforce: server },
    allowList: new ToolAllowList(o.mcpTools),
    redactor: o.redactor,
    mutationGuard: createOrgPolicyGuard({
      orgs: o.orgs,
      verifiedOrgIds: o.registry.verifiedOrgIds,
      ...(o.hasApproval ? { hasApproval: o.hasApproval } : {}),
    }),
    ...(o.audit ? { audit: o.audit } : {}),
    ...(o.logger ? { logger: o.logger } : {}),
    ...(o.transportFactory ? { transportFactory: o.transportFactory } : {}),
  });
}
