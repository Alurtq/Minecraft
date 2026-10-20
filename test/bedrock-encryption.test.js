import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicKey, createECDH, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import WebSocket from 'ws';
import { BedrockBridge } from '../src/bedrock.js';

async function waitUntil(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('Expected bridge state was not reached');
}

test('negotiates ws:encrypt and accepts trailing plaintext before continuous encrypted binary frames', { timeout: 5000 }, async t => {
  const bridge = new BedrockBridge({ port: 0 });
  t.after(() => bridge.close());
  const { port } = await bridge.start();
  const game = new WebSocket(`ws://127.0.0.1:${port}`, 'com.microsoft.minecraft.wsencrypt', { skipUTF8Validation: true });
  let encrypt;
  let decrypt;
  const commands = [];
  game.on('message', (data, binary) => {
    assert.equal(binary, Boolean(decrypt), 'Modern Bedrock ciphertext uses binary frames; initialization uses text');
    const request = JSON.parse((decrypt ? decrypt.update(data) : data).toString());
    const header = { version: 1, messagePurpose: 'commandResponse', requestId: request.header.requestId };
    if (request.header.messagePurpose === 'ws:encrypt') {
      commands.push('ws:encrypt');
      assert.equal(request.body.mode, 'cfb8');
      assert.deepEqual(Object.keys(request.body).sort(), ['mode', 'publicKey', 'salt']);
      const encodedServerKey = request.body.publicKey;
      const encodedSalt = request.body.salt;
      assert.equal(Buffer.from(encodedServerKey, 'base64').toString('base64'), encodedServerKey);
      assert.equal(Buffer.from(encodedSalt, 'base64').toString('base64'), encodedSalt);
      assert.equal(Buffer.from(encodedSalt, 'base64').length, 16);
      const jwk = createPublicKey({ key: Buffer.from(encodedServerKey, 'base64'), type: 'spki', format: 'der' }).export({ format: 'jwk' });
      const serverPoint = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
      const peer = createECDH('secp384r1');
      const point = peer.generateKeys();
      const peerKey = createPublicKey({ key: { kty: 'EC', crv: 'P-384', x: point.subarray(1, 49).toString('base64url'), y: point.subarray(49).toString('base64url') }, format: 'jwk' });
      const shared = peer.computeSecret(serverPoint);
      assert.equal(shared.length, 48);
      const key = createHash('sha256').update(Buffer.from(encodedSalt, 'base64')).update(shared).digest();
      encrypt = createCipheriv('aes-256-cfb8', key, key.subarray(0, 16));
      decrypt = createDecipheriv('aes-256-cfb8', key, key.subarray(0, 16));
      // Match the live client's sequence: key reply without statusCode, another
      // plaintext commandResponse, then encrypted binary data in the same batch.
      game._socket.cork();
      game.send(JSON.stringify({
        header: { version: 1, messagePurpose: 'ws:encrypt', requestId: request.header.requestId },
        body: { publicKey: peerKey.export({ type: 'spki', format: 'der' }).toString('base64') },
      }));
      game.send(JSON.stringify({ header, body: {} }));
      game.send(encrypt.update(Buffer.from(JSON.stringify({ header: { version: 1, messagePurpose: 'event', eventName: 'PlayerTransform' }, body: {} }))), { binary: true });
      game._socket.uncork();
      return;
    }
    assert.equal(request.header.version, 1, 'Ordinary commands retain protocol version 1');
    assert.equal(request.header.messagePurpose, 'commandRequest');
    commands.push(request.body.commandLine.split(' ')[0]);
    if (request.body.commandLine === 'getlocalplayername') {
      const response = Buffer.from(JSON.stringify({ header, body: { statusCode: 0, localplayername: 'test-player' } }));
      game.send(encrypt ? encrypt.update(response) : response, { binary: Boolean(encrypt) });
    } else {
      const body = { statusCode: 0, statusMessage: 'OK', details: '[]' };
      game.send(encrypt.update(Buffer.from(JSON.stringify({ header, body }))), { binary: true });
    }
  });
  await once(game, 'open');
  await waitUntil(() => bridge.status().ready);
  assert.equal(bridge.status().encryption, 'enabled');
  assert.equal(bridge.status().websocketProtocol, 'com.microsoft.minecraft.wsencrypt');
  for (const command of ['querytarget @s', 'getlocalplayername']) {
    assert.equal((await bridge.command(command)).statusCode, 0);
  }
  assert.deepEqual(commands, ['getlocalplayername', 'ws:encrypt', 'querytarget', 'getlocalplayername']);
  assert.equal(bridge.status().diagnostics.invalidJsonFrames, 0);
  assert.equal(bridge.status().diagnostics.binaryFrames, 3);
  assert.doesNotMatch(JSON.stringify(bridge.status()), /BEGIN PUBLIC KEY|publicKey|enableencryption "/);
});

test('failed encrypted initialization reports the error without closing the game socket', { timeout: 5000 }, async t => {
  const bridge = new BedrockBridge({ port: 0 });
  t.after(() => bridge.close());
  const { port } = await bridge.start();
  const game = new WebSocket(`ws://127.0.0.1:${port}`, 'com.microsoft.minecraft.wsencrypt');
  game.on('message', data => {
    const request = JSON.parse(data.toString());
    game.send(JSON.stringify({ header: { requestId: request.header.requestId, messagePurpose: 'commandResponse' }, body: { statusCode: -1, statusMessage: 'Not supported' } }));
  });
  await once(game, 'open');
  await waitUntil(() => bridge.status().initialization === 'failed');
  assert.equal(bridge.status().ready, false);
  assert.equal(bridge.status().connected, true);
  assert.equal(game.readyState, WebSocket.OPEN);
  await assert.rejects(bridge.command('querytarget @s'), { code: 'SESSION_NOT_READY' });
});

test('a late player-name reply continues encrypted initialization without reconnecting', { timeout: 5000 }, async t => {
  const bridge = new BedrockBridge({ port: 0, commandTimeoutMs: 40 });
  t.after(() => bridge.close());
  const { port } = await bridge.start();
  const game = new WebSocket(`ws://127.0.0.1:${port}`, 'com.microsoft.minecraft.wsencrypt');
  const first = once(game, 'message');
  await once(game, 'open');
  const [data] = await first;
  const request = JSON.parse(data.toString());
  assert.equal(request.body.commandLine, 'getlocalplayername');
  await waitUntil(() => bridge.status().initialization === 'failed');
  assert.ok(bridge.status().awaitingLateResponse);
  const next = once(game, 'message');
  game.send(JSON.stringify({ header: { requestId: request.header.requestId, messagePurpose: 'commandResponse' }, body: { statusCode: 0, localplayername: 'returned-player' } }));
  const [offer] = await next;
  const encryptionRequest = JSON.parse(offer.toString());
  assert.equal(encryptionRequest.header.messagePurpose, 'ws:encrypt');
  assert.equal(encryptionRequest.body.mode, 'cfb8');
  assert.equal(encryptionRequest.body.commandLine, undefined);
  assert.equal(bridge.status().initialization, 'negotiating_encryption');
  assert.equal(game.readyState, WebSocket.OPEN);
});
