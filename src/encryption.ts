/**
 * Built-in encryption utility for the SignalDB Tauri adapter.
 *
 * Uses the Web Crypto API (available in all Tauri webviews) to provide
 * AES-256-GCM authenticated encryption with PBKDF2 key derivation.
 *
 * **Algorithm details:**
 * - **Key derivation**: PBKDF2 with SHA-256, 100,000 iterations (OWASP 2025 recommendation)
 * - **Encryption**: AES-256-GCM (authenticated, detects tampering)
 * - **Salt**: 16 random bytes per encryption session
 * - **IV/Nonce**: 12 random bytes per encryption operation (GCM standard)
 * - **Key versioning**: Embedded version tag enables seamless key rotation
 *
 * **On-disk format:**
 * ```
 * v{version}:{base64(salt || iv || ciphertext+authTag)}
 * ```
 *
 * **⚠️ Important security notes:**
 * - A low-entropy passphrase (e.g., a short password) is the weakest link.
 *   Use a high-entropy string (32+ random chars) or derive from a user password
 *   with additional protections (e.g., OS keychain).
 * - This provides **at-rest** encryption. Data is decrypted in memory during use.
 * - Key rotation is handled via the version prefix — old data remains readable
 *   if you keep the old passphrase in the map.
 */

import type { EncryptFunction, DecryptFunction, EncryptionOptions, EncryptionPair } from './types';

/** Salt length in bytes (128 bits) */
const SALT_LENGTH = 16;

/** AES-GCM IV/nonce length in bytes (96 bits) */
const IV_LENGTH = 12;

/** Default PBKDF2 iteration count (OWASP 2025 recommendation: 100k for SHA-256) */
const DEFAULT_ITERATIONS = 100_000;

/** Separator between version prefix and payload */
const VERSION_SEPARATOR = ':';

/** Prefix marker for versioned payloads */
const VERSION_PREFIX = 'v';

// ─── Internal helpers ───────────────────────────────────────────────────

/**
 * Check whether the Web Crypto API is available.
 * Should always be true in Tauri v2 webviews, but we guard for safety.
 */
function requireWebCrypto(): void {
  if (
    typeof crypto === 'undefined' ||
    typeof crypto.subtle === 'undefined' ||
    typeof crypto.getRandomValues === 'undefined'
  ) {
    throw new Error(
      'Web Crypto API is not available. ' +
        'This encryption utility requires a Tauri v2 webview or equivalent ' +
        'environment with crypto.subtle support.'
    );
  }
}

/**
 * Cast a Uint8Array for use with Web Crypto API methods.
 * Workaround for TS 7.0 where Uint8Array generic defaults to ArrayBufferLike
 * instead of ArrayBuffer, making it incompatible with BufferSource.
 */
function asBufferSource(arr: Uint8Array): Uint8Array<ArrayBuffer> {
  return arr as Uint8Array<ArrayBuffer>;
}

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
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    asBufferSource(enc.encode(passphrase) as Uint8Array),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: asBufferSource(salt),
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
 * (plaintext fallback — the caller should handle this gracefully).
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
 */
function encodeVersionedPayload(version: number, payload: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < payload.byteLength; i++) {
    binary += String.fromCharCode(payload[i]);
  }
  return `${VERSION_PREFIX}${version}${VERSION_SEPARATOR}${btoa(binary)}`;
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Create an encryption/decryption pair using AES-256-GCM.
 *
 * @param passphrases - A single passphrase string (used for version 1) or a
 *   map of version numbers to passphrases for key rotation support.
 * @param options - Optional configuration for iteration count and active version.
 * @returns An object with `encrypt` and `decrypt` functions that can be
 *   passed directly to `createTauriFileSystemAdapter`.
 *
 * @example
 * ```ts
 * // Simple usage — single passphrase
 * import { createEncryption } from '@pitzzahh/signaldb-adapter-tauri';
 *
 * const { encrypt, decrypt } = createEncryption('your-strong-passphrase');
 *
 * const adapter = createTauriFileSystemAdapter('data.json', {
 *   encrypt,
 *   decrypt,
 *   security: { enforceEncryption: true, allowPlaintextFallback: false }
 * });
 * ```
 *
 * @example
 * ```ts
 * // Key rotation support
 * const { encrypt, decrypt } = createEncryption({
 *   1: 'old-passphrase',  // old key, kept for reading old data
 *   2: 'new-passphrase',  // current key, used for new writes
 * }, { version: 2 });
 * ```
 */
export function createEncryption(
  passphrases: string | Record<number, string>,
  options: EncryptionOptions = {},
): EncryptionPair {
  requireWebCrypto();

  const passphraseMap: Record<number, string> =
    typeof passphrases === 'string' ? { 1: passphrases } : { ...passphrases };

  const activeVersion = options.version ?? 1;
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;

  if (!Number.isInteger(activeVersion) || activeVersion < 1) {
    throw new Error(`Version must be a positive integer, got: ${activeVersion}`);
  }

  if (!passphraseMap[activeVersion]) {
    throw new Error(
      `No passphrase configured for version ${activeVersion}. ` +
        `Available versions: ${Object.keys(passphraseMap).join(', ')}`,
    );
  }

  if (iterations < 10_000) {
    console.warn(
      `[SECURITY WARNING] PBKDF2 iterations set to ${iterations}. ` +
        'OWASP recommends at least 100,000 for SHA-256.',
    );
  }

  const encrypt: EncryptFunction<unknown> = async (data) => {
    const passphrase = passphraseMap[activeVersion];
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

    const key = await deriveKey(passphrase, salt, iterations);

    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    // AES-GCM appends the 16-byte authentication tag to the ciphertext
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: asBufferSource(iv) },
      key,
      asBufferSource(plaintext),
    );

    const binaryPayload = concat(salt, iv, new Uint8Array(encrypted));
    return encodeVersionedPayload(activeVersion, binaryPayload);
  };

  const decrypt: DecryptFunction<unknown> = async (raw) => {
    const parsed = parseVersionedPayload(raw);
    if (!parsed) {
      throw new Error(
        'Failed to parse encrypted payload: data is not in the expected ' +
          'versioned format. The data may be unencrypted, corrupted, or ' +
          'encrypted with a different scheme.',
      );
    }

    const { version, payload } = parsed;
    const passphrase = passphraseMap[version];
    if (!passphrase) {
      throw new Error(
        `Unknown key version: ${version}. ` +
          `Available versions: ${Object.keys(passphraseMap).join(', ')}. ` +
          'This data was encrypted with a key that is no longer configured.',
      );
    }

    if (payload.byteLength < SALT_LENGTH + IV_LENGTH + 16) {
      // Minimum: salt (16) + iv (12) + at least 1 byte ciphertext + 16 byte auth tag
      throw new Error(
        'Encrypted payload is too short — data may be truncated or corrupted.',
      );
    }

    const salt = payload.slice(0, SALT_LENGTH);
    const iv = payload.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const ciphertext = payload.slice(SALT_LENGTH + IV_LENGTH);

    const key = await deriveKey(passphrase, salt, iterations);

    let decrypted: ArrayBuffer;
    try {
      decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: asBufferSource(iv) },
        key,
        asBufferSource(ciphertext),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Decryption failed (version ${version}): ${msg}. ` +
          'This may indicate a wrong passphrase, tampered data, or corruption.',
        { cause: err },
      );
    }

    const plaintext = new TextDecoder().decode(decrypted);
    return JSON.parse(plaintext);
  };

  return { encrypt, decrypt };
}
