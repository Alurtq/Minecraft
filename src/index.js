#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { BedrockBridge } from './bedrock.js';
import { makeFill, makeSetBlock, normalizeCommand } from './commands.js';

const port = Number(process.env.BEDROCK_WS_PORT ?? 19131);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('BEDROCK_WS_PORT must be an integer from 0 to 65535.');
}
const bridge = new BedrockBridge({ port });
await bridge.start();

const server = new McpServer({ name: 'minecraft-bedrock', version: '0.1.0' });
const position = z.object({ x: z.int(), y: z.int(), z: z.int() });
const block = z.string().min(1).describe('Bedrock block ID, e.g. minecraft:stone or minecraft:oak_planks.');
const states = z.record(z.string(), z.union([z.string(), z.boolean(), z.int()])).default({});
const dimension = z.enum(['overworld', 'nether', 'the_end']).default('overworld');
const command = z.string().min(1).max(32768).describe('One Bedrock command, with or without leading /. Runs as the connected player; ~ and @s refer to that player.');
const writeAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const failed = result => result.messagePurpose === 'error' || result.statusCode < 0;
const reply = (data, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  ...(isError ? { isError: true } : {}),
});
const handle = action => async args => {
  try { return await action(args); }
  catch (error) { return reply({ error: error.message, code: error.code, resultUnknown: error.resultUnknown }, true); }
};

server.registerTool('minecraft_status', {
  description: 'Check the Bedrock connection, session readiness, encryption, unresolved requests and bounded response diagnostics. Returns the exact /connect command. No world changes.',
  inputSchema: z.object({}),
  annotations: { readOnlyHint: true, openWorldHint: false },
}, () => reply(bridge.status()));

server.registerTool('minecraft_command', {
  description: 'Run one command in the connected Minecraft Bedrock world and return the game response. Requires cheats and /connect. A timeout means the outcome is unknown; do not retry automatically. Use Bedrock syntax, not Java syntax.',
  inputSchema: z.object({ command }),
  annotations: writeAnnotations,
}, handle(async ({ command }) => {
  const result = await bridge.command(normalizeCommand(command));
  return reply(result, failed(result));
}));

server.registerTool('minecraft_batch', {
  description: 'Run up to 128 Bedrock commands as one isolated job. By default, wait for each response and stop at the first failure. For independent commands, set concurrency to 4 or 8 and stopOnError to false to overlap response waits. Concurrent commands must not depend on execution order, player movement or one another. There is no rollback; already-sent commands may execute after a failure. Timeout/disconnection stops dispatch, reports unknown outcomes and never retries. Use responseDetail="summary" to return counts and failures without repeating successful results.',
  inputSchema: z.object({
    commands: z.array(command).min(1).max(128),
    stopOnError: z.boolean().default(true),
    concurrency: z.int().min(1).max(16).default(1),
    responseDetail: z.enum(['full', 'summary']).default('full'),
  }),
  annotations: writeAnnotations,
}, handle(async ({ commands, stopOnError, concurrency, responseDetail }) => {
  const batch = await bridge.batch(commands, { stopOnError, concurrency });
  const hasError = Boolean(batch.error) || batch.results.some(failed);
  if (responseDetail === 'summary') {
    const { results, ...summary } = batch;
    return reply({
      ...summary,
      succeeded: results.filter(result => !failed(result)).length,
      failed: results.filter(failed).length,
      unknown: (batch.failures ?? []).filter(failure => failure.resultUnknown).length,
      commandFailures: results.filter(failed),
    }, hasError);
  }
  return reply(batch, hasError);
}));

server.registerTool('minecraft_set_block', {
  description: 'Place one block at absolute integer coordinates in a chosen dimension. Supports Bedrock block states. Returns the actual game response.',
  inputSchema: z.object({ position, block, states, mode: z.enum(['replace', 'keep', 'destroy']).default('replace'), dimension }),
  annotations: writeAnnotations,
}, handle(async args => {
  const result = await bridge.command(makeSetBlock(args));
  return reply(result, failed(result));
}));

server.registerTool('minecraft_fill', {
  description: 'Fill a box between inclusive absolute corners, up to this tool’s 32768-block cap. Modes include hollow and outline. The area must be loaded in the game. No automatic splitting or rollback.',
  inputSchema: z.object({ from: position, to: position, block, states, mode: z.enum(['replace', 'keep', 'outline', 'hollow', 'destroy']).default('replace'), dimension }),
  annotations: writeAnnotations,
}, handle(async args => {
  const result = await bridge.command(makeFill(args));
  return reply(result, failed(result));
}));

const transport = new StdioServerTransport();
let closing;
function shutdown() {
  closing ??= Promise.allSettled([bridge.close(), server.close()]);
  return closing;
}
process.stdin.once('end', shutdown);
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
await server.connect(transport);
console.error(`Minecraft Bedrock MCP ready. In your world: ${bridge.status().connectCommand}`);
