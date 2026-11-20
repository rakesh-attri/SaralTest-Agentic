// Minimal MCP server used by unit tests (in-memory and stdio). Offers one observe, one mutate, one blocked and one
// unlisted tool. Never talks to Salesforce.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export const FAKE_TOOLS = ['get_record', 'create_record', 'deploy_metadata', 'mystery_tool', 'failing_tool'];

export function createFakeServer() {
  const server = new Server({ name: 'fake-sf', version: '1.0.0' }, { capabilities: { tools: {} } });
  const calls = [];
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: FAKE_TOOLS.map((name) => ({ name, description: `fake ${name}`, inputSchema: { type: 'object' } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, (req) => {
    calls.push(req.params.name);
    if (req.params.name === 'failing_tool') {
      return {
        isError: true,
        content: [{ type: 'text', text: 'INVALID_SESSION_ID: Session expired for jane@acme.example' }],
      };
    }
    if (req.params.name === 'create_record') {
      return {
        content: [{ type: 'text', text: '{"id":"001FIXTURE0000001AAA","success":true}' }],
        structuredContent: { id: '001FIXTURE0000001AAA', success: true },
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ tool: req.params.name, args: req.params.arguments ?? {} }) }],
    };
  });
  return { server, calls };
}

// Run as a stdio server when executed directly: `node tests/fixtures/mcp-fake-server.mjs`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const { server } = createFakeServer();
  await server.connect(new StdioServerTransport());
}
