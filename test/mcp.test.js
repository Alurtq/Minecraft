import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import WebSocket from 'ws';

const payload = result => JSON.parse(result.content[0].text);

test('MCP stdio handshake, tools and game responses work together', { timeout: 20000 }, async t => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
    env: { ...process.env, BEDROCK_WS_PORT: '0' },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', data => { stderr += data.toString(); });
  const client = new Client({ name: 'bedrock-mcp-test', version: '1.0.0' });
  let game;
  t.after(async () => {
    game?.terminate();
    await client.close();
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'minecraft_batch', 'minecraft_command', 'minecraft_fill', 'minecraft_set_block', 'minecraft_status',
  ]);
  const initial = payload(await client.callTool({ name: 'minecraft_status', arguments: {} }));
  assert.equal(initial.connected, false);
  assert.ok(initial.port > 0);
  const disconnected = await client.callTool({ name: 'minecraft_command', arguments: { command: 'say hello' } });
  assert.equal(disconnected.isError, true);

  const received = [];
  game = new WebSocket(`ws://127.0.0.1:${initial.port}`);
  game.on('message', data => {
    const frame = JSON.parse(data.toString());
    received.push(frame);
    const error = frame.body.commandLine === 'invalid_command';
    game.send(JSON.stringify({
      header: { version: 1, messagePurpose: 'commandResponse', requestId: frame.header.requestId },
      body: { statusCode: error ? -2147483648 : 0, statusMessage: error ? 'Syntax error' : 'OK' },
    }));
  });
  await once(game, 'open');
  assert.equal(payload(await client.callTool({ name: 'minecraft_status', arguments: {} })).connected, true);

  const placed = await client.callTool({ name: 'minecraft_set_block', arguments: {
    position: { x: 1, y: 64, z: 2 }, block: 'minecraft:stone',
  } });
  assert.notEqual(placed.isError, true);
  assert.equal(payload(placed).statusCode, 0);
  assert.match(received.at(-1).body.commandLine, /^execute in overworld run setblock 1 64 2 minecraft:stone(?: \[\])? replace$/);
  assert.equal(received.at(-1).body.version, undefined, 'use the current client command syntax');

  const beforeInvalid = received.length;
  const invalidBatch = await client.callTool({ name: 'minecraft_batch', arguments: { commands: ['say first', 'say second\nstop'] } });
  assert.equal(invalidBatch.isError, true);
  assert.equal(received.length, beforeInvalid, 'validate all commands before sending the first one');

  const batch = await client.callTool({ name: 'minecraft_batch', arguments: { commands: ['say first', 'invalid_command', 'say last'] } });
  assert.equal(batch.isError, true);
  assert.equal(payload(batch).completed, 2);
  assert.deepEqual(received.slice(-2).map(frame => frame.body.commandLine), ['say first', 'invalid_command']);
  const continued = await client.callTool({ name: 'minecraft_batch', arguments: { commands: ['invalid_command', 'say last'], stopOnError: false } });
  assert.equal(continued.isError, true);
  assert.equal(payload(continued).completed, 2);

  const filled = await client.callTool({ name: 'minecraft_fill', arguments: {
    from: { x: 0, y: 64, z: 0 }, to: { x: 3, y: 67, z: 3 }, block: 'minecraft:glass', mode: 'hollow',
  } });
  assert.notEqual(filled.isError, true);
  const beforeLarge = received.length;
  const oversized = await client.callTool({ name: 'minecraft_fill', arguments: {
    from: { x: 0, y: 0, z: 0 }, to: { x: 32, y: 32, z: 32 }, block: 'stone',
  } });
  assert.equal(oversized.isError, true);
  assert.equal(received.length, beforeLarge);
  assert.match(stderr, /Minecraft Bedrock MCP ready/);
});
