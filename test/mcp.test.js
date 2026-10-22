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
  let respondToGame;
  game = new WebSocket(`ws://127.0.0.1:${initial.port}`);
  game.on('message', data => {
    const frame = JSON.parse(data.toString());
    received.push(frame);
    if (respondToGame) {
      respondToGame(frame);
      return;
    }
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

  const beforeUnsafe = received.length;
  const unsafePipeline = await client.callTool({ name: 'minecraft_batch', arguments: {
    commands: ['say one', 'say two'], concurrency: 4,
  } });
  assert.equal(unsafePipeline.isError, true);
  assert.equal(received.length, beforeUnsafe, 'concurrency requires explicit stopOnError=false');

  const pipelineRequests = [];
  respondToGame = frame => {
    pipelineRequests.push(frame);
    if (pipelineRequests.length !== 4) return;
    // Do not acknowledge anything until the entire window has arrived. A
    // serial implementation cannot pass this real MCP-to-WebSocket check.
    for (const index of [2, 0, 3, 1]) {
      const request = pipelineRequests[index];
      game.send(JSON.stringify({
        header: { version: 1, messagePurpose: 'commandResponse', requestId: request.header.requestId },
        body: { statusCode: index === 2 ? -1 : 0, statusMessage: index === 2 ? 'Simulated failure' : 'OK' },
      }));
    }
  };
  const pipelined = await client.callTool({ name: 'minecraft_batch', arguments: {
    commands: ['say independent 0', 'say independent 1', 'say independent 2', 'say independent 3'],
    concurrency: 4, stopOnError: false, responseDetail: 'summary',
  } });
  assert.equal(pipelined.isError, true);
  const pipelineSummary = payload(pipelined);
  assert.equal(pipelineRequests.length, 4);
  assert.equal(pipelineSummary.completed, 4);
  assert.equal(pipelineSummary.sent, 4);
  assert.equal(pipelineSummary.skipped, 0);
  assert.equal(pipelineSummary.succeeded, 3);
  assert.equal(pipelineSummary.failed, 1);
  assert.equal(pipelineSummary.unknown, 0);
  assert.equal(pipelineSummary.results, undefined, 'summary omits successful result bodies');
  assert.equal(pipelineSummary.commandFailures[0].command, 'say independent 2');
  respondToGame = undefined;

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

  let beforeDisconnect = 0;
  respondToGame = () => {
    beforeDisconnect += 1;
    if (beforeDisconnect === 4) game.terminate();
  };
  const disconnectedBatch = await client.callTool({ name: 'minecraft_batch', arguments: {
    commands: Array.from({ length: 6 }, (_, index) => `say disconnect ${index}`),
    concurrency: 4, stopOnError: false, responseDetail: 'summary',
  } });
  assert.equal(disconnectedBatch.isError, true);
  const disconnectedSummary = payload(disconnectedBatch);
  assert.equal(disconnectedSummary.sent, 4);
  assert.equal(disconnectedSummary.skipped, 2);
  assert.equal(disconnectedSummary.completed, 0);
  assert.equal(disconnectedSummary.unknown, 4);
  assert.equal(disconnectedSummary.resultUnknown, true);
  assert.deepEqual(disconnectedSummary.failures.map(failure => failure.index), [0, 1, 2, 3, 4, 5]);
  assert.equal(disconnectedSummary.failures.filter(failure => failure.resultUnknown).length, 4);
  assert.deepEqual(disconnectedSummary.commandFailures, []);
});
