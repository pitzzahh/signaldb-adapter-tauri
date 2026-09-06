/**
 * AES-256-GCM encryption for the SignalDB Tauri adapter.
 * Uses Web Crypto API with PBKDF2 key derivation (100k iterations).
 * On-disk format: `v{version}:{base64(salt || iv || ciphertext+authTag)}`
 */

import type { EncryptionOptions } from './types';
import { eMsg, encoder, decoder } from './utils';

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

/** Concatenate Uint8Arrays into a single buffer. */
function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, a) => sum + a.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.byteLength;
  }
  return result;
}

/**
 * Derive an AES-256-GCM key from a passphrase using PBKDF2.
 */
async function deriveKey(
  passphrase: string,
  salt: BufferSource,
  iterations: number,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

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
function parseVersionedPayload(
  raw: string,
): { version: number; payload: Uint8Array } | null {
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
 * Chunked to avoid O(n^2) concat and btoa stack limits on large payloads.
 */
function encodeVersionedPayload(version: number, payload: Uint8Array): string {
  const CHUNK = 0x2000;
  let binary = '';
  for (let i = 0; i < payload.byteLength; i += CHUNK) {
    const sub = payload.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...sub);
  }
  return `${VERSION_PREFIX}${version}${VERSION_SEPARATOR}${btoa(binary)}`;
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

  const encrypt = async <T>(data: T[]): Promise<string> => {
    const passphrase = passphraseMap[activeVersion];
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

    const key = await deriveKey(passphrase, salt, iterations);

    const plaintext = encoder.encode(JSON.stringify(data));
    // AES-GCM appends the 16-byte authentication tag to the ciphertext
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plaintext,
    );

    const binaryPayload = concat(salt, iv, new Uint8Array(encrypted));
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

    const salt = payload.slice(0, SALT_LENGTH);
    const iv = payload.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const ciphertext = payload.slice(SALT_LENGTH + IV_LENGTH);

    const key = await deriveKey(passphrase, salt, iterations);

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

  return { encrypt, decrypt };
}
