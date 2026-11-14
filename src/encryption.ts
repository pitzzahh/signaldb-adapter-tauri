/**
 * AES-256-GCM encryption for the SignalDB Tauri adapter.
 * Uses Web Crypto API with PBKDF2 key derivation (100k iterations).
 * On-disk format: `v{version}:{base64(salt || iv || ciphertext+authTag)}`
 */

import type { EncryptedPayload, EncryptionOptions } from './types';
import { eMsg, encoder, decoder, JSON_CODEC } from './utils';

/** Salt length in bytes (128 bits) */
const SALT_LENGTH = 16;

/** AES-GCM IV/nonce length in bytes (96 bits) */
const IV_LENGTH = 12;

/** Default PBKDF2 iteration count. Minimum 100k for SHA-256; OWASP
 * Password Storage recommends 600k. Raise via options.iterations
 * if your devices can afford the startup cost. */
const DEFAULT_ITERATIONS = 100_000;

/** Separator between version prefix and payload */
const VERSION_SEPARATOR = ':';

/** Prefix marker for versioned payloads */
const VERSION_PREFIX = 'v';

// ─── Internal helpers ───────────────────────────────────────────────────

/**
 * Derive an AES-256-GCM key from key material using PBKDF2.
 */
async function deriveKey(
  keyMaterial: CryptoKey,
  salt: BufferSource,
  iterations: number,
): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Parse a versioned payload string.
 *
 * Expected format: `v{version}:{base64payload}`
 * Returns `null` if the string is not in the expected format
 * (plaintext fallback; the caller should handle this gracefully).
 */
function parseVersionedPayload(raw: string): EncryptedPayload | null {
  // Must start with 'v' and contain the separator
  if (!raw.startsWith(VERSION_PREFIX)) return null;

  const sepIdx = raw.indexOf(VERSION_SEPARATOR);
  if (sepIdx === -1) return null;

  const versionStr = raw.slice(1, sepIdx);
  const version = Number(versionStr);
  if (!Number.isInteger(version) || version < 1) return null;

  const base64 = raw.slice(sepIdx + 1);
  if (base64.length === 0) return null;

  try {
    const binary = atob(base64);
    const payload = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      payload[i] = binary.charCodeAt(i);
    }
    return { version, payload };
  } catch {
    return null; // Invalid base64
  }
}

/**
 * Encode a binary payload into the versioned string format.
 * fromCharCode.apply, not a ...spread: spreading a typed array goes through
 * its iterator and is ~6x slower. CHUNK is a multiple of 3, so per-chunk
 * btoa pads only the last chunk and the output equals one btoa call.
 */
function encodeVersionedPayload(version: number, payload: Uint8Array): string {
  const CHUNK = 0x3000;
  const parts: string[] = [];
  for (let i = 0; i < payload.byteLength; i += CHUNK) {
    const sub = payload.subarray(i, i + CHUNK) as unknown as number[];
    parts.push(btoa(String.fromCharCode.apply(null, sub)));
  }
  return `${VERSION_PREFIX}${version}${VERSION_SEPARATOR}${parts.join('')}`;
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Create an encryption/decryption pair using AES-256-GCM.
 *
 * @param passphrases - A passphrase string or a map of version numbers
 *   to passphrases for key rotation.
 * @param options - Optional configuration for iterations and active version.
 * @returns An object with `encrypt` and `decrypt` functions.
 */
export function createEncryption(
  passphrases: string | Record<number, string>,
  options: EncryptionOptions = {},
): {
  encrypt: <T>(data: T[]) => Promise<string>;
  decrypt: <T>(encrypted: string) => Promise<T[]>;
} {
  const passphraseMap: Record<number, string> =
    typeof passphrases === 'string' ? { 1: passphrases } : { ...passphrases };

  const activeVersion = options.version ?? 1;
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;

  if (!Number.isInteger(activeVersion) || activeVersion < 1) {
    throw new Error(`Version must be a positive integer, got ${activeVersion}`);
  }

  const activePassphrase = passphraseMap[activeVersion];
  if (typeof activePassphrase !== 'string' || activePassphrase.length === 0) {
    throw new Error(
      `No passphrase for version ${activeVersion}. Available: ${Object.keys(passphraseMap).join(', ')}`,
    );
  }
  if (activePassphrase.length < 12) {
    console.warn(
      `[SECURITY] Passphrase for v${activeVersion} is short (${activePassphrase.length} chars). Use 12+ chars.`,
    );
  }

  if (iterations < 100_000) {
    console.warn(
      `[SECURITY] PBKDF2 iterations low (${iterations}). Use >=100,000 (OWASP recommends 600,000).`,
    );
  }

  // importKey per passphrase is cached, so the import is paid once.
  const keyMaterialCache = new Map<string, Promise<CryptoKey>>();
  const getKeyMaterial = (passphrase: string): Promise<CryptoKey> => {
    let cached = keyMaterialCache.get(passphrase);
    if (!cached) {
      cached = crypto.subtle.importKey(
        'raw',
        encoder.encode(passphrase),
        'PBKDF2',
        false,
        ['deriveKey'],
      );
      keyMaterialCache.set(passphrase, cached);
    }
    return cached;
  };

  // PBKDF2 runs once per (version, salt), not once per message. Each
  // instance encrypts under one random salt, so writes reuse one derived
  // key; AES-GCM stays safe because every message gets a fresh random IV
  // (NIST's 2^32-messages-per-key bound is far beyond one app session).
  const encryptSalt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const derivedKeys = new Map<string, Promise<CryptoKey>>();
  const getKey = (version: number, passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> => {
    const id = `${version}:${salt.join(',')}`;
    let key = derivedKeys.get(id);
    if (!key) {
      // Bounds memory if many foreign-salted payloads are decrypted.
      if (derivedKeys.size >= 8) derivedKeys.clear();
      key = getKeyMaterial(passphrase).then((material) => deriveKey(material, salt, iterations));
      derivedKeys.set(id, key);
      key.catch(() => derivedKeys.delete(id));
    }
    return key;
  };

  const encrypt = async <T>(data: T[]): Promise<string> => {
    const passphrase = passphraseMap[activeVersion];
    const salt = encryptSalt;
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

    const key = await getKey(activeVersion, passphrase, salt);

    const plaintext = encoder.encode(JSON.stringify(data));
    // AES-GCM appends the 16-byte authentication tag to the ciphertext
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plaintext,
    );

    const encryptedBytes = new Uint8Array(encrypted);
    const binaryPayload = new Uint8Array(SALT_LENGTH + IV_LENGTH + encryptedBytes.byteLength);
    binaryPayload.set(salt, 0);
    binaryPayload.set(iv, SALT_LENGTH);
    binaryPayload.set(encryptedBytes, SALT_LENGTH + IV_LENGTH);
    return encodeVersionedPayload(activeVersion, binaryPayload);
  };

  const decrypt = async <T>(raw: string): Promise<T[]> => {
    const parsed = parseVersionedPayload(raw);
    if (!parsed) {
      throw new Error(
        'Invalid encrypted payload: not in versioned format.',
      );
    }

    const { version, payload } = parsed;
    const passphrase = passphraseMap[version];
    if (!passphrase) {
      throw new Error(
        `Unknown key version ${version}. Available: ${Object.keys(passphraseMap).join(', ')}.`,
      );
    }

    if (payload.byteLength < SALT_LENGTH + IV_LENGTH + 16) {
      // Minimum: salt (16) + iv (12) + at least 1 byte ciphertext + 16 byte auth tag
      throw new Error(
        'Payload too short: truncated or corrupted.',
      );
    }

    const salt = payload.subarray(0, SALT_LENGTH);
    const iv = payload.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const ciphertext = payload.subarray(SALT_LENGTH + IV_LENGTH);

    const key = await getKey(version, passphrase, salt);

    let decrypted: ArrayBuffer;
    try {
      decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        ciphertext,
      );
    } catch (err) {
      const msg = eMsg(err);
      throw new Error(
        `Decryption failed (v${version}): ${msg}.`,
        { cause: err },
      );
    }

    const plaintext = decoder.decode(decrypted);
    const parsed_data: unknown = JSON.parse(plaintext);
    if (!Array.isArray(parsed_data)) {
      throw new Error('Decrypted payload is not an array: corrupted.');
    }
    return parsed_data;
  };

  (encrypt as any)[JSON_CODEC] = (decrypt as any)[JSON_CODEC] = true;
  return { encrypt, decrypt };
}
