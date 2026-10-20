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

async function waitUntil(condition) {
  const deadline = Date.now() + 1000;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(condition(), 'condition was not reached');
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
  assert.equal(bridge.status().supportsEncryptedWebsockets, true);
  assert.equal(bridge.status().encryption, 'disabled');
  assert.equal(bridge.status().ready, true);
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

test('invalid matching responses quarantine commands without closing the game connection', async (t) => {
  for (const body of [{}, { statusCode: '0' }, { statusCode: null }]) {
    const { bridge, game } = await setup(t);
    let sent = 0;
    game.on('message', () => { sent += 1; });
    const next = receive(game);
    const results = Promise.allSettled([bridge.command('say first'), bridge.command('say next')]);
    const request = await next;
    respond(game, request, body);
    const [active, queued] = await results;
    assert.equal(active.status, 'rejected');
    assert.equal(active.reason.code, 'INVALID_RESPONSE');
    assert.equal(active.reason.resultUnknown, true);
    assert.equal(queued.reason.resultUnknown, false);
    assert.equal(sent, 1);
    assert.equal(bridge.status().connected, true);
    assert.equal(game.readyState, WebSocket.OPEN);
    assert.equal(bridge.status().awaitingLateResponse.requestId, request.header.requestId);
    await assert.rejects(bridge.command('say blocked'), { code: 'COMMAND_RESULT_PENDING', resultUnknown: false });
    respond(game, request);
    await waitUntil(() => bridge.status().awaitingLateResponse === null);
    assert.equal(sent, 1);
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

test('timeout retains the connection, blocks new commands and never replays the queue', async (t) => {
  const { bridge, game } = await setup(t, { commandTimeoutMs: 40 });
  let sent = 0;
  let closed = false;
  game.on('message', () => { sent += 1; });
  game.on('close', () => { closed = true; });
  const next = receive(game);
  const first = bridge.command('setblock 0 70 0 stone');
  const second = bridge.command('setblock 1 70 0 stone');
  const outcomes = Promise.allSettled([first, second]);
  const request = await next;
  const [active, queued] = await outcomes;
  assert.equal(active.reason.code, 'COMMAND_TIMEOUT');
  assert.equal(active.reason.resultUnknown, true);
  assert.equal(queued.reason.resultUnknown, false);
  assert.equal(sent, 1);
  assert.equal(bridge.status().connected, true);
  assert.equal(game.readyState, WebSocket.OPEN);
  assert.equal(closed, false);
  assert.equal(bridge.status().queuedCommands, 0);
  assert.equal(bridge.status().inFlight, null);
  assert.deepEqual(bridge.status().awaitingLateResponse, {
    requestId: request.header.requestId,
    command: 'setblock 0 70 0 stone',
    timedOutAt: bridge.status().awaitingLateResponse.timedOutAt,
  });
  assert.ok(bridge.status().awaitingLateResponse.timedOutAt);
  await assert.rejects(bridge.command('say blocked'), { code: 'COMMAND_RESULT_PENDING', resultUnknown: false });
  game.send(JSON.stringify({ header: { requestId: 'unrelated', messagePurpose: 'commandResponse' }, body: { statusCode: 0 } }));
  await waitUntil(() => bridge.status().diagnostics.receivedFrames === 1);
  assert.equal(bridge.status().awaitingLateResponse.requestId, request.header.requestId);
  respond(game, request);
  await waitUntil(() => bridge.status().awaitingLateResponse === null);
  assert.equal(sent, 1);
  assert.equal(bridge.status().lastError, null);
  const nextAfterLateResponse = receive(game);
  const result = bridge.command('say late response received');
  const newRequest = await nextAfterLateResponse;
  assert.equal(newRequest.body.commandLine, 'say late response received');
  assert.notEqual(newRequest.header.requestId, request.header.requestId);
  respond(game, newRequest);
  await result;
  assert.equal(sent, 2);
});

test('quarantined requests clear safely on disconnect and close', async (t) => {
  for (const action of ['disconnect', 'close']) {
    const { bridge, game } = await setup(t, { commandTimeoutMs: 30 });
    const result = bridge.command('say timeout');
    await assert.rejects(result, { code: 'COMMAND_TIMEOUT', resultUnknown: true });
    assert.ok(bridge.status().awaitingLateResponse);
    if (action === 'close') await bridge.close();
    else {
      game.close(1000, 'Manual disconnect');
      await waitUntil(() => !bridge.status().connected);
      assert.equal(bridge.status().lastDisconnect.code, 1000);
      assert.equal(bridge.status().lastDisconnect.reason, 'Manual disconnect');
    }
    assert.equal(bridge.status().awaitingLateResponse, null);
    assert.equal(bridge.status().inFlight, null);
  }
});

test('bounded diagnostics retain initial errors and metadata without command or chat payloads', async (t) => {
  const { bridge, game } = await setup(t);
  assert.equal(bridge.status().websocketProtocol, '');
  const statusMessage = 'x'.repeat(450);
  const errorPacket = {
    header: { messagePurpose: 'error', requestId: 'initial-uncorrelated-error' },
    body: { statusCode: -42, statusMessage, commandLine: 'private command', Message: 'private chat' },
  };
  const json = JSON.stringify(errorPacket);
  game.send(json);
  game.send(Buffer.from('{not JSON'), { binary: true });
  await waitUntil(() => bridge.status().diagnostics.receivedFrames === 2);
  let diagnostics = bridge.status().diagnostics;
  assert.equal(diagnostics.sentCommands, 0);
  assert.equal(diagnostics.invalidJsonFrames, 1);
  assert.equal(diagnostics.binaryFrames, 1);
  assert.ok(diagnostics.lastReceivedAt);
  assert.deepEqual(diagnostics.recentFrames[0], {
    receivedAt: diagnostics.recentFrames[0].receivedAt,
    binary: false,
    bytes: Buffer.byteLength(json),
    messagePurpose: 'error',
    requestId: 'initial-uncorrelated-error',
    statusCode: -42,
    statusMessage: 'x'.repeat(300),
    eventName: undefined,
  });
  assert.equal(diagnostics.recentFrames[1].invalidJson, true);
  assert.equal(diagnostics.recentFrames[1].binary, true);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private command|private chat/);
  // Mutating returned metadata cannot alter the bridge's retained evidence.
  diagnostics.recentFrames[0].statusCode = 123;
  assert.equal(bridge.status().diagnostics.recentFrames[0].statusCode, -42);
  for (let index = 0; index < 10; index += 1) {
    game.send(JSON.stringify({ header: { messagePurpose: 'event', eventName: 'PlayerMessage', requestId: `event-${index}` }, body: { Message: 'private chat' } }));
  }
  await waitUntil(() => bridge.status().diagnostics.receivedFrames === 12);
  diagnostics = bridge.status().diagnostics;
  assert.equal(diagnostics.recentFrames.length, 8);
  assert.equal(diagnostics.recentFrames[0].requestId, 'event-2');
  assert.equal(diagnostics.recentFrames[7].eventName, 'PlayerMessage');
  assert.doesNotMatch(JSON.stringify(diagnostics), /private chat/);

  game.close(1000, 'New session');
  await waitUntil(() => !bridge.status().connected);
  const reconnected = new WebSocket(`ws://127.0.0.1:${bridge.status().port}`);
  reconnected.on('error', () => {});
  await once(reconnected, 'open');
  assert.deepEqual(bridge.status().diagnostics, {
    receivedFrames: 0,
    invalidJsonFrames: 0,
    binaryFrames: 0,
    sentCommands: 0,
    lastReceivedAt: null,
    recentFrames: [],
  });
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

test('concurrent sessions select distinct ports without disrupting the first listener', async t => {
  const first = new BedrockBridge({ port: 0 });
  t.after(() => first.close());
  const address = await first.start();
  const second = new BedrockBridge({ port: address.port });
  t.after(() => second.close());
  const other = await second.start();
  assert.notEqual(other.port, address.port);
  assert.equal(first.status().port, address.port);
  assert.equal(second.status().port, other.port);
  assert.equal(second.status().lastError, null);
  assert.equal(second.status().connectCommand, `/connect 127.0.0.1:${other.port}`);
  const game = new WebSocket(`ws://127.0.0.1:${other.port}`);
  await once(game, 'open');
  const next = receive(game);
  const command = second.command('getlocalplayername');
  respond(game, await next);
  assert.equal((await command).statusCode, 0);
});
