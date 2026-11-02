import {
  createPersistenceAdapter,
  type PersistenceAdapter,
  type LoadResponse
} from '@signaldb/core';
import {
  BaseDirectory,
  exists,
  readDir,
  readFile,
  writeFile,
  remove,
  rename
} from '@tauri-apps/plugin-fs';
import type { SecurityOptions, AdapterOptions } from './types';
import { eMsg, encoder, decoder } from './utils';

/** Marks present-but-unreadable files so save() refuses to overwrite them. */
class CorruptDataError extends Error {
  constructor(filename: string, cause: unknown) {
    super(`Corrupt data in ${filename}`, { cause });
    this.name = 'CorruptDataError';
  }
}

/**
 * Validates and sanitizes filename to prevent path traversal attacks
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function validateFilename(filename: string): void {
  if (!filename || typeof filename !== 'string') {
    throw new Error('Filename must be a non-empty string');
  }

  // Check for path traversal attempts
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('Invalid filename: path traversal detected');
  }

  // Check for other dangerous characters: null bytes, control chars
  // (includes \n and \r), and characters illegal on Windows (< > : " | ? *)
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x1f<>:"|?*]/.test(filename)) {
    throw new Error('Invalid filename: illegal or control characters');
  }

  // Reject bare directory refs and trailing dots/spaces
  // (stripped silently on Windows, causing confusion)
  if (filename === '.' || /[. ]$/.test(filename)) {
    throw new Error('Invalid filename: reserved or trailing-dot name');
  }

  if (WINDOWS_RESERVED.test(filename)) {
    throw new Error('Invalid filename: reserved device name');
  }

  // Ensure reasonable length
  if (filename.length > 255) {
    throw new Error('Filename too long');
  }
}

/**
 * Default data validator for decrypted content
 */
function defaultDataValidator<T>(data: unknown): data is T[] {
  return Array.isArray(data);
}

/**
 * Creates a backup filename with unique identifier
 */
function createBackupFilename(filename: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${filename}.backup.${timestamp}.${crypto.randomUUID()}`;
}

/**
 * Cleans up old backup files, keeping only the most recent ones
 */
async function cleanupOldBackups(
  filename: string,
  maxBackups: number,
  baseDir: BaseDirectory
): Promise<void> {
  try {
    const entries = await readDir('.', { baseDir });
    const backup_pattern = `${filename}.backup.`;
    const backup_entries = entries
      .filter(entry => entry.name.startsWith(backup_pattern))
      // Newest first (ISO timestamps sort lexicographically; plain compare, no locale cost)
      .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));

    // Remove oldest backups beyond the limit, in parallel
    await Promise.all(backup_entries.slice(maxBackups).map(async (entry) => {
      try {
        await remove(entry.name, { baseDir });
      } catch (removeError) {
        console.warn(`Failed to remove old backup ${entry.name}:`, removeError);
      }
    }));
  } catch (error) {
    console.warn(`Failed to cleanup old backups for ${filename}:`, error);
  }
}

/**
 * Creates a SignalDB persistence adapter backed by Tauri's filesystem API.
 * Supports optional AES-256-GCM encryption, atomic writes, and backups.
 *
 * @param filename - The file to store data in (sanitized for security).
 * @param options - Configuration including encryption and security settings.
 * @returns A configured persistence adapter instance.
 */
export function adapter<T extends { id: ID } & Record<string, any>, ID = string>(
  filename: string,
  options?: AdapterOptions<T>
): PersistenceAdapter<T, ID> {
  // Validate filename for security
  validateFilename(filename);

  const base_dir = options?.base_dir || BaseDirectory.AppLocalData;
  const security: SecurityOptions = {
    enforceEncryption: false,
    allowPlaintextFallback: false,
    validateDecryptedData: true,
    propagateCallbackErrors: false,
    dataValidator: defaultDataValidator,
    createBackups: false, // Disable backups by default for sync scenarios
    maxBackups: 5, // Keep only the last 5 backups if enabled
    ...options?.security
  };

  // Security check: warn about unencrypted storage
  if (!options?.encrypt && !security.enforceEncryption) {
    console.warn(
      `[SECURITY] No encryption for ${filename}. ` +
      'Data stored as plaintext. Enable encryption for production.',
    );
  }

  // Performance tip: inform about backup behavior for sync scenarios
  if (security.createBackups) {
    console.info(
      `[INFO] Backups enabled for ${filename}. ` +
      'Disable via security.createBackups:false for sync scenarios.',
    );
  }

  // Security check: enforce encryption if required
  if (security.enforceEncryption && (typeof options?.encrypt !== 'function' || typeof options?.decrypt !== 'function')) {
    throw new Error(
      'Encryption enforced but encrypt/decrypt not provided.',
    );
  }

  // Reject half-configured encryption: encrypt without decrypt writes
  // ciphertext that load() cannot parse, losing data on the next save.
  if ((options?.encrypt != null) !== (options?.decrypt != null)) {
    throw new Error(
      'encrypt and decrypt must be provided together.',
    );
  }

  let change_callback: ((data?: LoadResponse<T>) => void | Promise<void>) | null = null;
  let is_registered = false;
  // Serialize saves so concurrent save() calls cannot interleave
  // read-modify-write and lose updates. Each save chains onto the last.
  let saveQueue: Promise<void> = Promise.resolve();
  // Monotonic save id for write coalescing (see save()).
  let saveSeq = 0;

  // Standalone loader so register/save do not depend on `this`.
  // Keeps working even if adapter methods are destructured.
  // Throws CorruptDataError on corrupt files; save() relies on that to
  // refuse overwriting them, while load() maps it to empty (see below).
  const loadDataInternal = async (): Promise<LoadResponse<T>> => {
    try {
      // Atomic check and read to prevent TOCTOU race conditions
      let contents: Uint8Array;
      try {
        contents = await readFile(filename, { baseDir: base_dir });
      } catch (error) {
        const msg = eMsg(error).toLowerCase();
        // Only return empty if the file truly doesn't exist
        if (msg.includes('not found') || msg.includes('no such file')) {
          return { items: [] };
        }
        throw error; // Re-throw I/O errors, permission errors, etc.
      }

      const text_content = decoder.decode(contents);

      // No-copy blank check (trim() would copy multi-MB files)
      if (text_content.length === 0 || !/\S/.test(text_content)) return { items: [] };

      let decrypted_data: T[];

      if (options?.decrypt) {
        try {
          decrypted_data = await options.decrypt(text_content);

          // Validate decrypted data structure if validation is enabled
          if (security.validateDecryptedData) {
            const validator = security.dataValidator || defaultDataValidator;
            if (!validator<T>(decrypted_data)) {
              throw new Error('Decrypted data failed validation - corruption or tampering');
            }
          }
        } catch (decryptError) {
          const errorMsg = eMsg(decryptError);
          if (!security.allowPlaintextFallback) {
            throw new Error(
              `Decryption failed, plaintext fallback disabled: ${errorMsg}`,
              { cause: decryptError }
            );
          }

          console.warn(
            `[SECURITY] Decryption failed for ${filename}, trying plaintext fallback.`,
            decryptError
          );

          try {
            decrypted_data = JSON.parse(text_content);

            // Validate even fallback data
            if (security.validateDecryptedData) {
              const validator = security.dataValidator || defaultDataValidator;
              if (!validator<T>(decrypted_data)) {
                throw new Error('Fallback plaintext data failed validation');
              }
            }
          } catch (parseError) {
            const parseMsg = eMsg(parseError);
            throw new Error(
              `Decryption and plaintext parse both failed for ${filename}: ${parseMsg}`,
              { cause: parseError }
            );
          }
        }
      } else {
        try {
          decrypted_data = JSON.parse(text_content);

          // Validate data structure
          if (security.validateDecryptedData) {
            const validator = security.dataValidator || defaultDataValidator;
            if (!validator<T>(decrypted_data)) {
              throw new Error('Data failed validation - possible corruption');
            }
          }
        } catch (parseError) {
          const errorMsg = eMsg(parseError);
          if (errorMsg.includes('validation')) {
            throw parseError; // Re-throw validation errors as-is
          }
          // Fail closed: load() maps this to empty for backwards compat,
          // but save() refuses to overwrite the corrupt file.
          throw new CorruptDataError(filename, parseError);
        }
      }

      return { items: decrypted_data };
    } catch (error) {
      if (error instanceof CorruptDataError) throw error;
      const errorMsg = eMsg(error);
      // For certain errors, propagate them directly
      if (errorMsg.includes('Decryption failed, plaintext fallback disabled') ||
        errorMsg.includes('Data failed validation') ||
        errorMsg.includes('Fallback plaintext data failed validation')) {
        throw error;
      }
      // For other errors, wrap them for context
      throw new Error(`Failed to load ${filename}: ${errorMsg}`, { cause: error });
    }
  };

  // Public load: corrupt files load as empty (backwards compat) but warn
  // loudly; saves stay blocked until the file is fixed or removed.
  const loadData = async (): Promise<LoadResponse<T>> => {
    try {
      return await loadDataInternal();
    } catch (error) {
      if (error instanceof CorruptDataError) {
        console.warn(
          `[DATA] Corrupt JSON in ${filename}, loading as empty. ` +
          `Inspect the file; remove it if you intend a reset. ` +
          `Saves are blocked until the file is fixed or removed.`,
          error.cause ?? error,
        );
        return { items: [] };
      }
      throw error;
    }
  };

  return createPersistenceAdapter({
    async register(onChange) {
      change_callback = onChange;
      is_registered = true;

      const fileExists = await exists(filename, { baseDir: base_dir });

      if (!fileExists) {
        let initial_data: string;

        try {
          if (options?.encrypt) {
            initial_data = await options.encrypt([]);
          } else {
            initial_data = JSON.stringify([]);
          }

          await writeFile(filename, encoder.encode(initial_data), {
            baseDir: base_dir
          });
        } catch (error) {
          throw new Error(`Failed to initialize file ${filename}`, { cause: error });
        }
      }

      // Initial load and notify callback
      try {
        const initialData = await loadData();
        if (change_callback && initialData.items && initialData.items.length > 0) {
          await change_callback(initialData);
        }
      } catch (error) {
        console.warn(`Failed to load initial data for ${filename}:`, error);
      }
    },
    load: loadData,
    async save(items, _changes) {
      // Chain onto the queue so concurrent saves run one at a time.
      // Coalescing: a queued save superseded by a newer call skips its
      // write; the newest call always persists the latest full state.
      const save_id = ++saveSeq;
      const run = async (): Promise<void> => {
      if (save_id !== saveSeq) return; // superseded, newer save will persist
      try {
        // Create backup before modifying data (only if enabled)
        let backup_filename: string | null = null;
        if (security.createBackups) {
          backup_filename = createBackupFilename(filename);
        }

        // Guard read: refuse the save when the stored file is unreadable
        // or corrupt, so a save can never overwrite data it cannot see.
        try {
          await loadDataInternal();

          // Create backup of current state (only if backups are enabled)
          if (security.createBackups && backup_filename) {
            try {
              const current_content = await readFile(filename, { baseDir: base_dir });
              await writeFile(backup_filename, current_content, { baseDir: base_dir });

              // Clean up old backups
              await cleanupOldBackups(filename, security.maxBackups ?? 5, base_dir);
            } catch (backupError) {
              console.warn(`Failed to create backup ${backup_filename}:`, backupError);
            }
          }
        } catch (error) {
          throw new Error(
            `Failed to read ${filename} during save. Refusing to save to prevent data loss.`,
            { cause: error }
          );
        }

        // SignalDB always passes the full current state as items; persist
        // it directly instead of re-merging incremental changes. Re-merging
        // could only reproduce items or keep stale same-id disk content.
        const updated_items = items;

        let data_to_save: string;

        if (options?.encrypt) {
          try {
            data_to_save = await options.encrypt(updated_items);
          } catch (error) {
            throw new Error(`Failed to encrypt data for ${filename}`, { cause: error });
          }
        } else {
          data_to_save = JSON.stringify(updated_items);
        }

        // Use atomic write pattern: write to temporary file first
        const temp_filename = `${filename}.tmp.${crypto.randomUUID()}`;

        try {
          // Write to temporary file
          await writeFile(temp_filename, encoder.encode(data_to_save), {
            baseDir: base_dir
          });

          // Verify the temporary file was written correctly. A proven
          // content mismatch fails closed; a mere read-back I/O error warns.
          let temp_text: string | null = null;
          try {
            const temp_contents = await readFile(temp_filename, { baseDir: base_dir });
            temp_text = decoder.decode(temp_contents);
          } catch (verifyError) {
            console.warn(`Failed to verify temporary file ${temp_filename}:`, verifyError);
          }
          if (temp_text !== null && temp_text !== data_to_save) {
            const mismatch = new Error('Temp file verification failed: content mismatch');
            console.warn(`Failed to verify temporary file ${temp_filename}:`, mismatch);
            throw mismatch;
          }

          // Atomically replace the old file with the new one using rename
          // rename is atomic on most filesystems (unlike remove + write)
          await rename(temp_filename, filename, {
            oldPathBaseDir: base_dir,
            newPathBaseDir: base_dir
          });

        } catch (writeError) {
          // Clean up temp file on error
          try {
            const tempExists = await exists(temp_filename, { baseDir: base_dir });
            if (tempExists) {
              await remove(temp_filename, { baseDir: base_dir });
            }
          } catch (cleanupError) {
            console.warn(`Failed to cleanup temp file after error:`, cleanupError);
          }
          throw new Error(`Failed to write ${filename}`, { cause: writeError });
        }

        // Notify callback about the change if registered
        if (is_registered && change_callback) {
          // Clone data to prevent mutation in callback (structuredClone keeps Date/Map)
          const callback_data = { items: structuredClone(updated_items) };
          const cb = change_callback;
          if (security.propagateCallbackErrors) {
            try {
              await cb(callback_data);
            } catch (callbackError) {
              throw new Error(`Change callback failed for ${filename}`, { cause: callbackError });
            }
          } else {
            // Fire-and-forget: async subscribers settle after the save.
            const onErr = (callbackError: unknown) => {
              console.warn(`Change callback error for ${filename}:`, callbackError);
            };
            try {
              const result = cb(callback_data);
              if (result instanceof Promise) result.catch(onErr);
            } catch (callbackError) {
              onErr(callbackError);
            }
          }
        }
      } catch (error) {
        // Re-throw specific errors without wrapping
        const errorMsg = eMsg(error);
        if (errorMsg.includes('Change callback failed') || errorMsg.includes('Refusing to save')) {
          throw error;
        }
        throw new Error(`Failed to save ${filename}`, { cause: error });
      }
      };
      const pending = saveQueue.then(run, run);
      // Keep the chain alive even if this save fails.
      saveQueue = pending.catch(() => {});
      return pending;
    },
    async unregister() {
      // Clean up the change callback when unregistering
      is_registered = false;
      change_callback = null;
    }
  });
}

export type { EncryptedPayload, SecurityOptions, AdapterOptions, EncryptionOptions } from './types';
