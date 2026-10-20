import { createCipheriv, createDecipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes } from 'node:crypto';

// Protocol reference: https://github.com/mcpews/mcpews/blob/master/src/lib/encrypt.ts
// Offer format: https://github.com/mcpews/mcpews/blob/master/src/lib/server.ts
export function createEncryptionOffer() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const salt = randomBytes(16);
  const encodedKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const encodedSalt = salt.toString('base64');
  let completed = false;

  return {
    command: `enableencryption "${encodedKey}" "${encodedSalt}" cfb8`,
    requestBody: { mode: 'cfb8', publicKey: encodedKey, salt: encodedSalt },
    complete(clientPublicKeyBase64) {
      if (completed) throw new Error('encryption offer has already been completed');
      if (typeof clientPublicKeyBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(clientPublicKeyBase64)) {
        throw new TypeError('client public key must be base64-encoded DER SPKI');
      }
      const der = Buffer.from(clientPublicKeyBase64, 'base64');
      if (der.toString('base64').replace(/=+$/, '') !== clientPublicKeyBase64.replace(/=+$/, '')) {
        throw new TypeError('client public key must be valid base64');
      }
      let clientPublicKey;
      try {
        clientPublicKey = createPublicKey({ key: der, format: 'der', type: 'spki' });
      } catch {
        throw new TypeError('client public key must be valid DER SPKI');
      }
      if (clientPublicKey.asymmetricKeyType !== 'ec' || clientPublicKey.asymmetricKeyDetails?.namedCurve !== 'secp384r1') {
        throw new TypeError('client public key must use the EC P-384 curve');
      }
      const shared = diffieHellman({ privateKey, publicKey: clientPublicKey });
      // The modern protocol hashes the full, fixed-width P-384 ECDH secret.
      const key = createHash('sha256').update(salt).update(shared).digest();
      const iv = key.subarray(0, 16);
      const outgoing = createCipheriv('aes-256-cfb8', key, iv);
      const incoming = createDecipheriv('aes-256-cfb8', key, iv);
      completed = true;
      const update = (stream, buffer) => {
        if (!Buffer.isBuffer(buffer)) throw new TypeError('encryption input must be a Buffer');
        return stream.update(buffer);
      };
      return {
        encrypt: (buffer) => update(outgoing, buffer),
        decrypt: (buffer) => update(incoming, buffer),
      };
    },
  };
}
