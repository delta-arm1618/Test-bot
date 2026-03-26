'use strict';

const CryptoJS = require('crypto-js');
const config = require('../../config');

/**
 * AES-256 encryption for sensitive broker credentials stored in DB.
 * Uses config.security.aesKey (must be 32 chars).
 */

function encrypt(plaintext) {
  if (!plaintext) return null;
  const encrypted = CryptoJS.AES.encrypt(plaintext, config.security.aesKey);
  return encrypted.toString(); // Base64 ciphertext
}

function decrypt(ciphertext) {
  if (!ciphertext) return null;
  const bytes = CryptoJS.AES.decrypt(ciphertext, config.security.aesKey);
  return bytes.toString(CryptoJS.enc.Utf8);
}

module.exports = { encrypt, decrypt };
