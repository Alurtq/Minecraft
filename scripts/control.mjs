// Diagnostic MCP client for an active local session, using the official SDK.
// Reads one {name, arguments} tool call per input line; sends nothing on its own.
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const client = new Client({ name: 'minecraft-local-control', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
  env: { ...process.env },
  stderr: 'inherit',
});
const input = createInterface({ input: process.stdin, terminal: false });
process.once('SIGINT', () => input.close());
process.once('SIGTERM', () => input.close());
try {
  await client.connect(transport);
  const status = await client.callTool({ name: 'minecraft_status', arguments: {} });
  console.log(JSON.stringify({ type: 'ready', status: JSON.parse(status.content[0].text) }));
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      const result = await client.callTool(JSON.parse(line));
      console.log(JSON.stringify(result));
    } catch (error) {
      console.log(JSON.stringify({ error: error.message }));
    }
  }
} finally {
  await client.close();
  input.close();
  process.stdin.pause();
}
