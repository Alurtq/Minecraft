import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createECDH, createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { createEncryptionOffer } from '../src/encryption.js';

function readOffer(offer) {
  const match = /^enableencryption "([A-Za-z0-9+/=]+)" "([A-Za-z0-9+/=]+)" cfb8$/.exec(offer.command);
  assert.ok(match, 'legacy command specifies its cipher mode');
  assert.deepEqual(offer.requestBody, { mode: 'cfb8', publicKey: match[1], salt: match[2] });
  const publicKey = createPublicKey({ key: Buffer.from(offer.requestBody.publicKey, 'base64'), format: 'der', type: 'spki' });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    salt: Buffer.from(offer.requestBody.salt, 'base64'),
    serverPoint: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]),
  };
}

function makeClient(offer) {
  const { salt, serverPoint } = readOffer(offer);
  const ecdh = createECDH('secp384r1');
  const point = ecdh.generateKeys();
  const publicKey = createPublicKey({ key: {
    kty: 'EC', crv: 'P-384',
    x: point.subarray(1, 49).toString('base64url'),
    y: point.subarray(49).toString('base64url'),
  }, format: 'jwk' });
  const shared = ecdh.computeSecret(serverPoint);
  assert.equal(shared.length, 48);
  const key = createHash('sha256').update(Buffer.concat([salt, shared])).digest();
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    shared, key,
    encrypt: createCipheriv('aes-256-cfb8', key, key.subarray(0, 16)),
    decrypt: createDecipheriv('aes-256-cfb8', key, key.subarray(0, 16)),
  };
}

// Independent CFB8 implementation: AES-ECB encrypts the shift register per byte.
function byteFeedback(key) {
  let register = Buffer.from(key.subarray(0, 16));
  return (plaintext) => {
    const output = Buffer.alloc(plaintext.length);
    for (let i = 0; i < plaintext.length; i++) {
      const blockCipher = createCipheriv('aes-256-ecb', key, null);
      blockCipher.setAutoPadding(false);
      output[i] = plaintext[i] ^ blockCipher.update(register)[0];
      register = Buffer.concat([register.subarray(1), output.subarray(i, i + 1)]);
    }
    return output;
  };
}

test('offers fresh EC P-384 SPKI keys and padded-base64 16-byte salts for ws:encrypt', () => {
  const first = createEncryptionOffer();
  const second = createEncryptionOffer();
  assert.notEqual(first.command, second.command);
  assert.equal(readOffer(first).salt.length, 16);
  assert.equal(readOffer(first).serverPoint.length, 97);
  assert.equal(Buffer.from(first.requestBody.publicKey, 'base64').toString('base64'), first.requestBody.publicKey);
  assert.equal(Buffer.from(first.requestBody.salt, 'base64').toString('base64'), first.requestBody.salt);
  assert.ok(first.requestBody.salt.endsWith('=='));
});

test('encrypts and decrypts multiple frames with independent continuous directions', () => {
  const offer = createEncryptionOffer();
  const client = makeClient(offer);
  const server = offer.complete(client.publicKey);
  const manualEncrypt = byteFeedback(client.key);
  for (const text of ['first frame', 'Второй кадр', '', '{"header":{"version":1},"body":{}}']) {
    const payload = Buffer.from(text);
    const encrypted = server.encrypt(payload);
    assert.deepEqual(encrypted, manualEncrypt(payload));
    assert.deepEqual(client.decrypt.update(encrypted), payload);
    const reply = Buffer.from(`reply: ${text}`);
    assert.deepEqual(server.decrypt(client.encrypt.update(reply)), reply);
  }
});

test('hashes the complete 48-byte shared secret including a leading zero', () => {
  const offer = createEncryptionOffer();
  let client;
  for (let i = 0; i < 8192; i++) {
    const candidate = makeClient(offer);
    if (candidate.shared[0] === 0) { client = candidate; break; }
  }
  assert.ok(client, 'found a P-384 shared x-coordinate with a leading zero');
  const server = offer.complete(client.publicKey.replace(/=+$/, ''));
  const payload = Buffer.from('leading-zero ECDH compatibility');
  assert.deepEqual(client.decrypt.update(server.encrypt(payload)), payload);
});

test('rejects invalid peer encodings, malformed keys, and the wrong curve', () => {
  const offer = createEncryptionOffer();
  for (const value of [undefined, null, '', 'not base64!', 'A', 'YWJj', 'YWJj\n']) {
    assert.throws(() => offer.complete(value), TypeError);
  }
  for (const namedCurve of ['prime256v1', 'secp521r1']) {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve });
    assert.throws(() => offer.complete(publicKey.export({ format: 'der', type: 'spki' }).toString('base64')), /P-384/);
  }
  const { publicKey } = generateKeyPairSync('ed25519');
  assert.throws(() => offer.complete(publicKey.export({ format: 'der', type: 'spki' }).toString('base64')), /P-384/);
  const client = makeClient(offer);
  offer.complete(client.publicKey);
  assert.throws(() => offer.complete(client.publicKey), /already been completed/);
});

test('cipher methods require buffers and preserve the input', () => {
  const offer = createEncryptionOffer();
  const client = makeClient(offer);
  const server = offer.complete(client.publicKey);
  assert.throws(() => server.encrypt('text'), TypeError);
  assert.throws(() => server.decrypt(new Uint8Array([1])), TypeError);
  const payload = Buffer.from('input');
  server.encrypt(payload);
  assert.equal(payload.toString(), 'input');
});
