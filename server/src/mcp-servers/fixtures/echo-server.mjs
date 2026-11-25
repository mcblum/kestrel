// A tiny MCP server over stdio for the Test button's tests (probe.test.ts). It serves one tool, and
// refuses to start, printing what it was given, when ECHO_KEY is not the expected value.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

if (process.env.ECHO_KEY !== 'right-key') {
  process.stderr.write(`bad key: ${process.env.ECHO_KEY}\n`);
  process.exit(1);
}
const server = new McpServer({ name: 'echo', version: '1' });
server.registerTool('echo', { description: 'Says it back' }, async () => ({ content: [{ type: 'text', text: 'echo' }] }));
await server.connect(new StdioServerTransport());
