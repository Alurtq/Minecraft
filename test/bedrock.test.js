import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { BedrockBridge } from '../src/bedrock.js';

async function setup(t, options = {}) {
  const bridge = new BedrockBridge({ port: 0, ...options });
  t.after(() => bridge.close());
  const address = await bridge.start();
  const game = new WebSocket(`ws://127.0.0.1:${address.port}`);
  game.on('error', () => {});
  await once(game, 'open');
  return { bridge, game };
}

function receive(game) {
  return once(game, 'message').then(([data]) => JSON.parse(data.toString()));
}

function respond(game, request, body = { statusCode: 0, statusMessage: 'OK' }, messagePurpose = 'commandResponse') {
  game.send(JSON.stringify({
    header: { version: 1, requestId: request.header.requestId, messagePurpose },
    body,
  }));
}

test('uses slashless commands, UUID correlation and current command syntax', async (t) => {
  const { bridge, game } = await setup(t);
  assert.equal(bridge.status().connected, true);
  assert.equal(bridge.status().requireEncryptedWebsockets, false);
  assert.match(bridge.status().connectCommand, /^\/connect 127\.0\.0\.1:\d+$/);
  const requestReceived = receive(game);
  const result = bridge.command('/setblock 1 70 2 stone');
  const request = await requestReceived;
  assert.match(request.header.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(request.header, {
    version: 1,
    requestId: request.header.requestId,
    messageType: 'commandRequest',
    messagePurpose: 'commandRequest',
  });
  assert.deepEqual(request.body, {
    commandLine: 'setblock 1 70 2 stone',
    origin: { type: 'player' },
  });
  // Bad JSON, unrelated events and other request IDs cannot complete this request.
  game.send('{broken JSON');
  game.send(JSON.stringify({ header: { requestId: request.header.requestId, messagePurpose: 'event' }, body: {} }));
  game.send(JSON.stringify({ header: { requestId: 'other-id', messagePurpose: 'commandResponse' }, body: { statusCode: -1 } }));
  const body = { statusCode: 0, statusMessage: 'Block placed', position: { x: 1, y: 70, z: 2 } };
  respond(game, request, body);
  assert.deepEqual(await result, {
    requestId: request.header.requestId,
    command: 'setblock 1 70 2 stone',
    messagePurpose: 'commandResponse',
    statusCode: 0,
    body,
  });
});

test('preserves negative status codes and protocol error responses', async (t) => {
  const { bridge, game } = await setup(t);
  for (const purpose of ['commandResponse', 'error']) {
    const next = receive(game);
    const result = bridge.command('setblock 0 70 0 invalid_block');
    const request = await next;
    const body = { statusCode: -2147483648, statusMessage: 'Syntax error' };
    respond(game, request, body, purpose);
    assert.equal((await result).messagePurpose, purpose);
    assert.deepEqual((await result).body, body);
  }
});

test('invalid matching responses never report success or send queued commands', async (t) => {
  for (const body of [{}, { statusCode: '0' }, { statusCode: null }]) {
    const { bridge, game } = await setup(t);
    let sent = 0;
    game.on('message', () => { sent += 1; });
    const next = receive(game);
    const results = Promise.allSettled([bridge.command('say first'), bridge.command('say next')]);
    respond(game, await next, body);
    const [active, queued] = await results;
    assert.equal(active.status, 'rejected');
    assert.equal(active.reason.code, 'INVALID_RESPONSE');
    assert.equal(active.reason.resultUnknown, true);
    assert.equal(queued.reason.resultUnknown, false);
    assert.equal(sent, 1);
    assert.equal(bridge.status().connected, false);
  }
});

test('sends at most one command before the previous response', async (t) => {
  const { bridge, game } = await setup(t);
  const commands = [];
  game.on('message', (data) => commands.push(JSON.parse(data.toString())));
  const firstReceived = receive(game);
  const first = bridge.command('setblock 0 70 0 stone');
  const second = bridge.command('setblock 1 70 0 stone');
  const third = bridge.command('setblock 2 70 0 stone');
  const firstRequest = await firstReceived;
  assert.equal(commands.length, 1);
  assert.equal(bridge.status().queuedCommands, 2);
  const secondReceived = receive(game);
  respond(game, firstRequest);
  await first;
  const secondRequest = await secondReceived;
  assert.equal(commands.length, 2);
  const thirdReceived = receive(game);
  respond(game, secondRequest);
  await second;
  const thirdRequest = await thirdReceived;
  assert.equal(commands.length, 3);
  assert.notEqual(firstRequest.header.requestId, secondRequest.header.requestId);
  respond(game, thirdRequest);
  await third;
});

test('disconnect marks in-flight result unknown and rejects unsent queue', async (t) => {
  const { bridge, game } = await setup(t);
  const next = receive(game);
  const first = bridge.command('setblock 0 70 0 stone');
  const second = bridge.command('setblock 1 70 0 stone');
  const outcomes = Promise.allSettled([first, second]);
  await next;
  game.terminate();
  const [active, queued] = await outcomes;
  assert.equal(active.status, 'rejected');
  assert.equal(active.reason.resultUnknown, true);
  assert.match(active.reason.message, /Do not retry automatically/);
  assert.equal(queued.reason.resultUnknown, false);
  assert.match(queued.reason.message, /was not sent/);
  assert.equal(bridge.status().connected, false);
  await assert.rejects(bridge.command('say hello'), { code: 'NOT_CONNECTED' });
});

test('timeout ends the session without sending or replaying queued commands', async (t) => {
  const { bridge, game } = await setup(t, { commandTimeoutMs: 40 });
  let sent = 0;
  game.on('message', () => { sent += 1; });
  const first = bridge.command('setblock 0 70 0 stone');
  const second = bridge.command('setblock 1 70 0 stone');
  const [active, queued] = await Promise.allSettled([first, second]);
  assert.equal(active.reason.code, 'COMMAND_TIMEOUT');
  assert.equal(active.reason.resultUnknown, true);
  assert.equal(queued.reason.resultUnknown, false);
  assert.equal(sent, 1);
  assert.equal(bridge.status().connected, false);
  assert.equal(bridge.status().queuedCommands, 0);
  const reconnected = new WebSocket(`ws://127.0.0.1:${bridge.status().port}`);
  reconnected.on('error', () => {});
  await once(reconnected, 'open');
  const next = receive(reconnected);
  const result = bridge.command('say reconnected');
  const request = await next;
  assert.equal(request.body.commandLine, 'say reconnected');
  respond(reconnected, request);
  await result;
});

test('rejects a second game client without replacing the first', async (t) => {
  const { bridge, game } = await setup(t);
  const originalConnectedAt = bridge.status().connectedAt;
  const second = new WebSocket(`ws://127.0.0.1:${bridge.status().port}`);
  second.on('error', () => {});
  const secondClosed = once(second, 'close');
  await once(second, 'open');
  const [code] = await secondClosed;
  assert.equal(code, 1008);
  assert.equal(bridge.status().connectedAt, originalConnectedAt);
  const next = receive(game);
  const result = bridge.command('say first client');
  respond(game, await next);
  await result;
});

test('close rejects pending work and releases the listener', async (t) => {
  const { bridge, game } = await setup(t);
  const next = receive(game);
  const pending = bridge.command('setblock 0 70 0 stone');
  const rejected = assert.rejects(pending, { code: 'BRIDGE_CLOSED', resultUnknown: true });
  await next;
  await bridge.close();
  await rejected;
  assert.equal(bridge.status().listening, false);
  assert.equal(bridge.status().connected, false);
});

test('accepts only loopback listeners and rejects commands before connection', async () => {
  assert.throws(() => new BedrockBridge({ host: '0.0.0.0' }), /loopback/);
  assert.throws(() => new BedrockBridge({ port: -1 }), /Port/);
  const bridge = new BedrockBridge({ port: 0 });
  await assert.rejects(bridge.command('say hello'), { code: 'NOT_CONNECTED', resultUnknown: false });
  await bridge.close();
});
