import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { BedrockBridge } from '../src/bedrock.js';

async function setup(t, options = {}) {
  const bridge = new BedrockBridge({ port: 0, ...options });
  t.after(() => bridge.close());
  const { port } = await bridge.start();
  const game = new WebSocket(`ws://127.0.0.1:${port}`);
  game.on('error', () => {});
  const received = [];
  game.on('message', data => received.push(JSON.parse(data.toString())));
  await once(game, 'open');
  return { bridge, game, received };
}

async function until(predicate) {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('Expected bridge state was not reached');
}

function respond(game, request, statusCode = 0, messagePurpose = 'commandResponse') {
  game.send(JSON.stringify({
    header: { version: 1, requestId: request.header.requestId, messagePurpose },
    body: { statusCode, statusMessage: statusCode < 0 ? 'Command failed' : 'OK' },
  }));
}

test('pipeline bounds its sliding window and correlates out-of-order replies', async t => {
  const { bridge, game, received } = await setup(t);
  const commands = Array.from({ length: 8 }, (_, index) => `setblock ${index} 70 0 stone`);
  const batch = bridge.batch(commands, { concurrency: 3, stopOnError: false });
  await until(() => received.length === 3);
  assert.equal(bridge.status().inFlightCount, 3);
  assert.equal(bridge.status().queuedCommands, 5);
  // Completing the third request must free one slot, regardless of UUID order.
  respond(game, received[2]);
  await until(() => received.length === 4);
  assert.equal(bridge.status().inFlightCount, 3);
  await delay(15);
  assert.equal(received.length, 4, 'window must not grow while replies are held');
  const replied = new Set([2]);
  for (let index = 0; index < commands.length; index += 1) {
    if (replied.has(index)) continue;
    await until(() => received.length > index);
    respond(game, received[index], index === 5 ? -1 : 0);
    replied.add(index);
  }
  const result = await batch;
  assert.deepEqual(result.results.map(item => item.command), commands);
  assert.deepEqual(result.results.map(item => item.index), commands.map((_, index) => index));
  assert.equal(result.results[5].statusCode, -1);
  assert.deepEqual({ sent: result.sent, skipped: result.skipped, completed: result.completed },
    { sent: 8, skipped: 0, completed: 8 });
  assert.equal(new Set(received.map(item => item.header.requestId)).size, commands.length);
  assert.equal(bridge.status().inFlightCount, 0);
});

test('batches execute as FIFO jobs without interleaving other tool calls', async t => {
  const { bridge, game, received } = await setup(t);
  const batch = bridge.batch(['say batch-a', 'say batch-b', 'say batch-c']);
  const other = bridge.command('say independent-job');
  const nextBatch = bridge.batch(['say next-a', 'say next-b'], { concurrency: 2, stopOnError: false });
  for (let index = 0; index < 6; index += 1) {
    await until(() => received.length > index);
    respond(game, received[index]);
  }
  await Promise.all([batch, other, nextBatch]);
  assert.deepEqual(received.map(item => item.body.commandLine),
    ['say batch-a', 'say batch-b', 'say batch-c', 'say independent-job', 'say next-a', 'say next-b']);
});

test('ordered batches stop on a command error before sending remaining commands', async t => {
  const { bridge, game, received } = await setup(t);
  const batch = bridge.batch(['say first', 'say fails', 'say must-not-run']);
  const other = bridge.command('say later-job');
  await until(() => received.length === 1);
  respond(game, received[0]);
  await until(() => received.length === 2);
  respond(game, received[1], -1);
  const result = await batch;
  assert.equal(result.requested, 3);
  assert.equal(result.completed, 2);
  assert.equal(result.sent, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.results[1].statusCode, -1);
  assert.equal(result.error, undefined, 'known command errors remain in their response body');
  await until(() => received.length === 3);
  assert.equal(received[2].body.commandLine, 'say later-job');
  respond(game, received[2]);
  await other;
});

test('pipeline timeout quarantines the whole window until all valid late replies arrive', async t => {
  const { bridge, game, received } = await setup(t, { commandTimeoutMs: 40 });
  const batch = bridge.batch(['say 0', 'say 1', 'say 2', 'say 3', 'say 4'],
    { concurrency: 3, stopOnError: false });
  const queued = bridge.command('say queued-later-job');
  const rejected = assert.rejects(queued, { code: 'COMMAND_TIMEOUT', resultUnknown: false });
  await until(() => received.length === 3);
  const result = await batch;
  await rejected;
  assert.equal(result.code, 'COMMAND_TIMEOUT');
  assert.equal(result.resultUnknown, true);
  assert.equal(result.sent, 3);
  assert.equal(result.skipped, 2);
  assert.equal(result.completed, 0);
  assert.equal(result.failures.filter(item => item.resultUnknown).length, 3);
  assert.deepEqual(result.failures.map(item => item.index), [0, 1, 2, 3, 4]);
  assert.equal(bridge.status().awaitingLateResponseCount, 3);
  await assert.rejects(bridge.command('say blocked'), { code: 'COMMAND_RESULT_PENDING' });
  respond(game, received[2]);
  respond(game, received[0]);
  await until(() => bridge.status().awaitingLateResponseCount === 1);
  await assert.rejects(bridge.batch(['say also-blocked']), { code: 'COMMAND_RESULT_PENDING' });
  respond(game, received[1]);
  await until(() => bridge.status().awaitingLateResponseCount === 0);
  assert.equal(bridge.status().outstandingCommands, 0);
  assert.equal(bridge.status().queuedCommands, 0);
  const next = bridge.command('say recovered');
  await until(() => received.length === 4);
  assert.equal(received[3].body.commandLine, 'say recovered');
  respond(game, received[3]);
  await next;
  assert.equal(received.length, 4, 'timed-out or unsent commands must never replay');
});

test('pipeline disconnect marks every outstanding request unknown and unsent entries skipped', async t => {
  const { bridge, game, received } = await setup(t);
  const batch = bridge.batch(['say 0', 'say 1', 'say 2', 'say 3'], { concurrency: 2, stopOnError: false });
  await until(() => received.length === 2);
  respond(game, received[1]);
  await until(() => received.length === 3);
  game.terminate();
  const result = await batch;
  assert.equal(result.code, 'CONNECTION_CLOSED');
  assert.equal(result.resultUnknown, true);
  assert.equal(result.completed, 1);
  assert.equal(result.results[0].index, 1, 'partial results retain their original input index');
  assert.equal(result.sent, 3);
  assert.equal(result.skipped, 1);
  assert.equal(result.failures.filter(item => item.resultUnknown).length, 2);
  assert.equal(bridge.status().outstandingCommands, 0);
  assert.equal(bridge.status().connected, false);
});

test('validates every batch before sending and rejects queue overflow atomically', async t => {
  const { bridge, game, received } = await setup(t, { maxQueuedCommands: 2 });
  assert.throws(() => new BedrockBridge({ maxQueuedCommands: 0 }), /positive integer/);
  await assert.rejects(bridge.batch([]), /between 1 and 128/);
  await assert.rejects(bridge.batch(['say good', 'say bad\ncommand']), /single-line/);
  await assert.rejects(bridge.batch(['say good'], { concurrency: 17, stopOnError: false }), /between 1 and 16/);
  await assert.rejects(bridge.batch(['say good'], { concurrency: 2 }), /stopOnError=false/);
  await assert.rejects(bridge.batch(['say 0', 'say 1', 'say 2']), { code: 'QUEUE_FULL', resultUnknown: false });
  assert.equal(received.length, 0);
  const first = bridge.command('say active');
  await until(() => received.length === 1);
  const second = bridge.command('say queued');
  await assert.rejects(bridge.batch(['say overflow-0', 'say overflow-1']), { code: 'QUEUE_FULL' });
  assert.equal(bridge.status().queuedCommands, 1);
  respond(game, received[0]);
  await first;
  await until(() => received.length === 2);
  respond(game, received[1]);
  await second;
  assert.deepEqual(received.map(item => item.body.commandLine), ['say active', 'say queued']);
});

test('an invalid correlated response freezes the pipeline without accepting unrelated replies', async t => {
  const { bridge, game, received } = await setup(t);
  const batch = bridge.batch(['say 0', 'say 1', 'say unsent'], { concurrency: 2, stopOnError: false });
  await until(() => received.length === 2);
  game.send(JSON.stringify({ header: { requestId: received[0].header.requestId, messagePurpose: 'commandResponse' }, body: {} }));
  const result = await batch;
  assert.equal(result.code, 'INVALID_RESPONSE');
  assert.equal(result.sent, 2);
  assert.equal(result.skipped, 1);
  assert.equal(bridge.status().awaitingLateResponseCount, 2);
  game.send(JSON.stringify({ header: { requestId: 'unrelated', messagePurpose: 'commandResponse' }, body: { statusCode: 0 } }));
  await delay(10);
  assert.equal(bridge.status().awaitingLateResponseCount, 2);
  respond(game, received[0]);
  respond(game, received[1]);
  await until(() => bridge.status().awaitingLateResponseCount === 0);
  assert.equal(received.length, 2);
});
