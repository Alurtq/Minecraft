import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicKey, createECDH, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import WebSocket from 'ws';
import { BedrockBridge } from '../src/bedrock.js';

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('Expected encrypted pipeline state was not reached');
}

async function encryptedGame(t, { holdInitialization = false, ...options } = {}) {
  const bridge = new BedrockBridge({ port: 0, ...options });
  t.after(() => bridge.close());
  const { port } = await bridge.start();
  const game = new WebSocket(`ws://127.0.0.1:${port}`, 'com.microsoft.minecraft.wsencrypt', { skipUTF8Validation: true });
  game.on('error', () => {});
  const requests = [];
  const initialization = [];
  const outstanding = new Set();
  let peakOutstanding = 0;
  let encrypt;
  let decrypt;
  let playerNameRequest;

  function send(packet, encrypted = true) {
    const plaintext = Buffer.from(JSON.stringify(packet));
    game.send(encrypted ? encrypt.update(plaintext) : plaintext, { binary: encrypted });
  }

  function reply(request, body = { statusCode: 0 }) {
    outstanding.delete(request.header.requestId);
    send({
      header: { version: 1, messagePurpose: 'commandResponse', requestId: request.header.requestId },
      body,
    });
  }

  function completePlayerName() {
    assert.ok(playerNameRequest);
    send({
      header: { version: 1, messagePurpose: 'commandResponse', requestId: playerNameRequest.header.requestId },
      body: { statusCode: 0, localplayername: 'pipeline-test-player' },
    }, false);
  }

  game.on('message', (data, binary) => {
    assert.equal(binary, Boolean(decrypt), 'Every command after key exchange must preserve the continuous binary cipher stream');
    const request = JSON.parse((decrypt ? decrypt.update(data) : data).toString());
    if (request.header.messagePurpose === 'ws:encrypt') {
      initialization.push('ws:encrypt');
      assert.equal(request.body.mode, 'cfb8');
      const serverKey = createPublicKey({ key: Buffer.from(request.body.publicKey, 'base64'), type: 'spki', format: 'der' });
      const jwk = serverKey.export({ format: 'jwk' });
      const serverPoint = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
      const peer = createECDH('secp384r1');
      const point = peer.generateKeys();
      const peerKey = createPublicKey({
        key: { kty: 'EC', crv: 'P-384', x: point.subarray(1, 49).toString('base64url'), y: point.subarray(49).toString('base64url') },
        format: 'jwk',
      });
      const key = createHash('sha256').update(Buffer.from(request.body.salt, 'base64')).update(peer.computeSecret(serverPoint)).digest();
      encrypt = createCipheriv('aes-256-cfb8', key, key.subarray(0, 16));
      decrypt = createDecipheriv('aes-256-cfb8', key, key.subarray(0, 16));
      send({
        header: { version: 1, messagePurpose: 'ws:encrypt', requestId: request.header.requestId },
        body: { publicKey: peerKey.export({ type: 'spki', format: 'der' }).toString('base64') },
      }, false);
      // A trailing plaintext reply must not consume any of the decipher stream.
      send({ header: { version: 1, messagePurpose: 'commandResponse', requestId: request.header.requestId }, body: {} }, false);
      send({ header: { version: 1, messagePurpose: 'event', eventName: 'PlayerTransform' }, body: {} });
      return;
    }
    assert.equal(request.header.messagePurpose, 'commandRequest');
    if (!encrypt && request.body.commandLine === 'getlocalplayername') {
      initialization.push('getlocalplayername');
      playerNameRequest = request;
      if (!holdInitialization) completePlayerName();
      return;
    }
    requests.push(request);
    outstanding.add(request.header.requestId);
    peakOutstanding = Math.max(peakOutstanding, outstanding.size);
  });
  await once(game, 'open');
  await waitUntil(() => Boolean(playerNameRequest));
  return { bridge, game, requests, initialization, send, reply, completePlayerName, peak: () => peakOutstanding };
}

test('encrypted pipelining maps delayed out-of-order responses to input order without releasing duplicate or unknown UUIDs', { timeout: 10000 }, async t => {
  const fixture = await encryptedGame(t);
  const { bridge, requests, send, reply } = fixture;
  await waitUntil(() => bridge.status().ready);
  const commands = Array.from({ length: 6 }, (_, index) => `setblock ${index} 70 0 stone`);
  const batch = bridge.batch(commands, { concurrency: 4, stopOnError: false });
  await waitUntil(() => requests.length === 4);
  assert.deepEqual(requests.map(request => request.body.commandLine), commands.slice(0, 4));
  assert.equal(new Set(requests.map(request => request.header.requestId)).size, 4);

  let receivedFrames = bridge.status().diagnostics.receivedFrames;
  send({ header: { version: 1, messagePurpose: 'commandResponse', requestId: 'unrelated' }, body: { statusCode: 0 } });
  send({ header: { version: 1, messagePurpose: 'event', eventName: 'PlayerTransform' }, body: {} });
  await waitUntil(() => bridge.status().diagnostics.receivedFrames >= receivedFrames + 2);
  assert.equal(requests.length, 4, 'Unrelated encrypted responses and events cannot release a pipeline slot');

  reply(requests[2], { statusCode: 0, index: 2 });
  await waitUntil(() => requests.length === 5);
  receivedFrames = bridge.status().diagnostics.receivedFrames;
  reply(requests[2], { statusCode: 0, index: 2 });
  await waitUntil(() => bridge.status().diagnostics.receivedFrames > receivedFrames);
  assert.equal(requests.length, 5, 'A duplicate response cannot release the same slot twice');

  reply(requests[0], { statusCode: 0, index: 0 });
  await waitUntil(() => requests.length === 6);
  for (const index of [3, 5, 1, 4]) reply(requests[index], { statusCode: 0, index });
  const result = await batch;
  assert.equal(result.requested, commands.length);
  assert.equal(result.completed, commands.length);
  assert.equal(result.sent, commands.length);
  assert.deepEqual(result.results.map(response => response.command), commands);
  assert.deepEqual(result.results.map(response => response.body.index), [0, 1, 2, 3, 4, 5]);
  assert.equal(fixture.peak(), 4);
  assert.equal(bridge.status().outstandingCommands, 0);
  assert.equal(bridge.status().diagnostics.invalidJsonFrames, 0);
});

test('encrypted initialization remains exclusive and rejects a pipeline until the key exchange is ready', { timeout: 10000 }, async t => {
  const fixture = await encryptedGame(t, { holdInitialization: true });
  const { bridge, requests, initialization } = fixture;
  assert.equal(bridge.status().ready, false);
  await assert.rejects(bridge.command('say too early'), { code: 'SESSION_NOT_READY' });
  const earlyBatch = await Promise.resolve().then(() => bridge.batch(['say too early'], { concurrency: 4, stopOnError: false })).then(value => value, error => error);
  assert.equal(earlyBatch.code, 'SESSION_NOT_READY');
  assert.deepEqual(initialization, ['getlocalplayername']);
  assert.equal(requests.length, 0);
  fixture.completePlayerName();
  await waitUntil(() => bridge.status().ready);
  assert.deepEqual(initialization, ['getlocalplayername', 'ws:encrypt']);
  const batch = bridge.batch(['say ready one', 'say ready two'], { concurrency: 4, stopOnError: false });
  await waitUntil(() => requests.length === 2);
  fixture.reply(requests[1]);
  fixture.reply(requests[0]);
  assert.equal((await batch).completed, 2);
  assert.equal(bridge.status().diagnostics.invalidJsonFrames, 0);
});

test('encrypted pipeline timeout quarantines every sent UUID until all late replies arrive without replaying unsent commands', { timeout: 10000 }, async t => {
  const fixture = await encryptedGame(t, { commandTimeoutMs: 200 });
  const { bridge, requests, reply } = fixture;
  await waitUntil(() => bridge.status().ready);
  const commands = Array.from({ length: 6 }, (_, index) => `setblock ${index} 71 0 stone`);
  const batch = bridge.batch(commands, { concurrency: 4, stopOnError: false });
  await waitUntil(() => requests.length === 4);
  const result = await batch;
  assert.equal(result.code, 'COMMAND_TIMEOUT');
  assert.equal(result.resultUnknown, true);
  assert.equal(result.sent, 4);
  assert.equal(result.completed, 0);
  assert.equal(result.skipped, 2);
  assert.equal(bridge.status().awaitingLateResponseCount, 4);
  assert.equal(bridge.status().outstandingCommands, 4);
  await assert.rejects(bridge.command('say blocked'), { code: 'COMMAND_RESULT_PENDING', resultUnknown: false });

  for (const index of [2, 0, 3]) reply(requests[index], { statusCode: 0, index });
  await waitUntil(() => bridge.status().awaitingLateResponseCount === 1);
  assert.equal(bridge.status().outstandingCommands, 1);
  await assert.rejects(bridge.command('say still blocked'), { code: 'COMMAND_RESULT_PENDING', resultUnknown: false });
  assert.equal(requests.length, 4, 'Unsent commands and quarantined commands must never be replayed');

  reply(requests[1], { statusCode: 0, index: 1 });
  await waitUntil(() => bridge.status().awaitingLateResponseCount === 0);
  assert.equal(bridge.status().outstandingCommands, 0);
  const recovered = bridge.command('say recovered encrypted session');
  await waitUntil(() => requests.length === 5);
  assert.equal(requests[4].body.commandLine, 'say recovered encrypted session');
  reply(requests[4]);
  assert.equal((await recovered).statusCode, 0);
  assert.equal(bridge.status().diagnostics.invalidJsonFrames, 0);
});
