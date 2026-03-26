'use strict';

// Mock config for tests
process.env.AES_SECRET_KEY = 'test_secret_key_32_chars_exactly';
process.env.JWT_SECRET = 'test_jwt_secret';
process.env.DISCORD_TOKEN = 'test_token';
process.env.DISCORD_CLIENT_ID = 'test_client_id';
process.env.GUILD_ID = 'test_guild_id';
process.env.DATABASE_URL = 'postgresql://test:test@localhost/test';
process.env.HTTP_SECRET = 'test_http_secret';

const { encrypt, decrypt } = require('../../src/utils/crypto');

describe('Crypto — AES-256 encryption', () => {
  test('encrypts and decrypts a string correctly', () => {
    const original = 'my-secret-api-token-12345';
    const encrypted = encrypt(original);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(original);
  });

  test('encrypted value differs from original', () => {
    const original = 'my-secret-api-token-12345';
    const encrypted = encrypt(original);
    expect(encrypted).not.toBe(original);
  });

  test('two encryptions of same value produce different ciphertext (random IV)', () => {
    const original = 'same-value';
    const enc1 = encrypt(original);
    const enc2 = encrypt(original);
    expect(enc1).not.toBe(enc2);
  });

  test('decrypting different encryption of same value returns original', () => {
    const original = 'same-value';
    const enc1 = encrypt(original);
    const enc2 = encrypt(original);
    expect(decrypt(enc1)).toBe(original);
    expect(decrypt(enc2)).toBe(original);
  });

  test('handles null gracefully', () => {
    expect(encrypt(null)).toBeNull();
    expect(decrypt(null)).toBeNull();
  });

  test('encrypts unicode and special characters', () => {
    const original = 'тест-токен 🔑 #$%^&*()';
    const decrypted = decrypt(encrypt(original));
    expect(decrypted).toBe(original);
  });
});
