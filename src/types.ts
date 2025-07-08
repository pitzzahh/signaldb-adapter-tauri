export type EncryptFunction<T> = (data: T[]) => Promise<string>;
export type DecryptFunction<T> = (encrypted: string) => Promise<T[]>;

export interface SecurityOptions {
  /** Whether to enforce encryption (throw error if encrypt/decrypt not provided) */
  enforceEncryption: boolean;
  /** Whether to allow fallback to plaintext on decryption failure */
  allowPlaintextFallback: boolean;
  /** Whether to validate decrypted data structure */
  validateDecryptedData: boolean;
  /** Whether callback errors should propagate */
  propagateCallbackErrors: boolean;
  /** Custom data validator function */
  dataValidator: <T>(data: unknown) => data is T[];
  /** Whether to create backup files on save (default: false for sync scenarios) */
  createBackups: boolean;
  /** Maximum number of backup files to keep (default: 5) */
  maxBackups: number;
}

export interface AdapterOptions<T> {
  base_dir?: import('@tauri-apps/plugin-fs').BaseDirectory;
  encrypt?: EncryptFunction<T>;
  decrypt?: DecryptFunction<T>;
  security?: Partial<SecurityOptions>;
}
