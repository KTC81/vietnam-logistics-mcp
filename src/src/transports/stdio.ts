/**
 * Transport stdio cho MCP Local. stdout chỉ do SDK dùng cho khung giao thức.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServerHandle, TransportFactory } from '../core/types.js';

/** Tạo factory nối server với kênh stdio của tiến trình. */
export function createStdioTransport(): TransportFactory {
  let transport: StdioServerTransport | undefined;

  return {
    name: 'stdio',

    async start(server: McpServerHandle): Promise<void> {
      transport = new StdioServerTransport();
      await server.connect(transport);
    },

    async stop(): Promise<void> {
      const current = transport;
      transport = undefined;
      if (current !== undefined) {
        await current.close();
      }
    },
  };
}
