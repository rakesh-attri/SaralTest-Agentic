import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export declare const FAKE_TOOLS: string[];
export declare function createFakeServer(): {
  server: { connect(transport: Transport): Promise<void>; close(): Promise<void> };
  calls: string[];
};
