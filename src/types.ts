/**
 * Structure of encrypted data from the built-in `createEncryption`.
 * On-disk: `v{version}:{base64(salt || iv || ciphertext+authTag)}`.
 */
export interface EncryptedPayload {
  /** Key version number for key rotation support */
  version: number;
  /** Binary payload: salt (16B) + IV (12B) + AES-256-GCM ciphertext + auth tag */
  payload: Uint8Array;
}

export interface SecurityOptions {
  /** Enforce encryption (throw if encrypt/decrypt not provided) */
  enforceEncryption: boolean;
  /** Allow fallback to plaintext on decryption failure */
  allowPlaintextFallback: boolean;
  /** Validate decrypted data structure */
  validateDecryptedData: boolean;
  /** Whether callback errors should propagate */
  propagateCallbackErrors: boolean;
  /** Custom data validator function */
  dataValidator: <T>(data: unknown) => data is T[];
  /** Create backup files on save (default: false) */
  createBackups: boolean;
  /** Max backup files to keep (default: 5) */
  maxBackups: number;
}

export interface AdapterOptions<T> {
  base_dir?: import('@tauri-apps/plugin-fs').BaseDirectory;
  encrypt?: (data: T[]) => Promise<string>;
  decrypt?: (encrypted: string) => Promise<T[]>;
  security?: Partial<SecurityOptions>;
}

/**
 * Options for {@link createEncryption}.
 */
export interface EncryptionOptions {
  /**
   * Key version number for key rotation support.
   * @default 1
   */
  version?: number;

  /**
   * Number of PBKDF2 iterations.
   * OWASP 2025 recommends >=100,000 for SHA-256.
   * @default 100_000
   */
  iterations?: number;
}
