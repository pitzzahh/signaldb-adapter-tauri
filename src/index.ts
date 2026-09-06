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

const eMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Clone items for the change callback so callback mutations
 * cannot corrupt adapter state. Prefers structuredClone (keeps
 * Date, Map, etc.); falls back to JSON for older runtimes.
 */
function cloneForCallback<T>(items: T[]): T[] {
  if (typeof structuredClone === 'function') {
    return structuredClone(items);
  }
  return JSON.parse(JSON.stringify(items));
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

  // Check for other dangerous characters: null, newlines, control chars,
  // and characters illegal on Windows (< > : " | ? *)
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x1f<>:"|?*]/.test(filename) || filename.includes('\n') || filename.includes('\r')) {
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
      .sort((a, b) => b.name.localeCompare(a.name)); // newest first (ISO timestamps sort lexicographically)

    // Remove oldest backups beyond the limit
    for (let i = maxBackups; i < backup_entries.length; i++) {
      try {
        await remove(backup_entries[i].name, { baseDir });
      } catch (removeError) {
        console.warn(`Failed to remove old backup ${backup_entries[i].name}:`, removeError);
      }
    }
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
export function createTauriFileSystemAdapter<T extends { id: ID } & Record<string, any>, ID = string>(
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

  let change_callback: ((data?: LoadResponse<T>) => void | Promise<void>) | null = null;
  let is_registered = false;
  // Serialize saves so concurrent save() calls cannot interleave
  // read-modify-write and lose updates. Each save chains onto the last.
  let saveQueue: Promise<void> = Promise.resolve();

  // Standalone loader so register/save do not depend on `this`.
  // Keeps working even if adapter methods are destructured.
  const loadData = async (): Promise<LoadResponse<T>> => {
    try {
      // Atomic check and read to prevent TOCTOU race conditions
      let contents: Uint8Array;
      try {
        contents = await readFile(filename, { baseDir: base_dir });
      } catch (error) {
        const msg = eMsg(error);
        // Only return empty if the file truly doesn't exist
        if (msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('no such file')) {
          return { items: [] };
        }
        throw error; // Re-throw I/O errors, permission errors, etc.
      }

      const text_content = decoder.decode(contents);

      if (!text_content.trim()) return { items: [] };

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
          // Backwards compat: corrupt JSON loads as empty, but warn loudly
          // so corruption is not silent. The next save refuses to overwrite
          // when it cannot read, so this does not cause silent data loss.
          console.warn(
            `[DATA] Corrupt JSON in ${filename}, loading as empty. ` +
            `Inspect the file; remove it if you intend a reset.`,
            parseError,
          );
          return { items: [] };
        }
      }

      return { items: decrypted_data };
    } catch (error) {
      const errorMsg = eMsg(error);
      // For certain errors, propagate them directly
      if (errorMsg.includes('Decryption failed and plaintext fallback is disabled') ||
        errorMsg.includes('Data failed validation') ||
        errorMsg.includes('Fallback plaintext data failed validation')) {
        throw error;
      }
      // For other errors, wrap them for context
      throw new Error(`Failed to load ${filename}: ${errorMsg}`, { cause: error });
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
    async save(items, changes) {
      // Chain onto the queue so concurrent saves run one at a time.
      const run = async (): Promise<void> => {
      try {
        // Create backup before modifying data (only if enabled)
        let backup_filename: string | null = null;
        if (security.createBackups) {
          backup_filename = createBackupFilename(filename);
        }

        // Use incremental updates with the changes parameter for better performance
        let current_items: T[] = [];

        // First, load current data if file exists
        try {
          const current_data = await loadData();
          current_items = current_data.items || [];

          // Create backup of current state (only if backups are enabled)
          if (security.createBackups && backup_filename) {
            try {
              const current_content = await readFile(filename, { baseDir: base_dir });
              await writeFile(backup_filename, current_content, { baseDir: base_dir });

              // Clean up old backups
              await cleanupOldBackups(filename, security.maxBackups || 5, base_dir);
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

        // Apply changes incrementally. SignalDB always passes changes,
        // but normalize defensively so undefined/null cannot throw.
        const safeChanges = changes ?? { added: [], modified: [], removed: [] };
        let updated_items = [...current_items];

        // Remove items first
        if (safeChanges.removed && safeChanges.removed.length > 0) {
          const removedIds = new Set(safeChanges.removed.map(item => item.id));
          updated_items = updated_items.filter(item => !removedIds.has(item.id));
        }

        // Update existing items
        if (safeChanges.modified && safeChanges.modified.length > 0) {
          const modifiedMap = new Map(safeChanges.modified.map(item => [item.id, item]));
          updated_items = updated_items.map(item =>
            modifiedMap.has(item.id) ? modifiedMap.get(item.id)! : item
          );
        }

        // Add new items
        if (safeChanges.added && safeChanges.added.length > 0) {
          updated_items.push(...safeChanges.added);
        }

        // Verify the result matches the provided items array
        // This ensures data integrity
        const expected_ids = new Set(items.map(item => item.id));
        const actual_ids = new Set(updated_items.map(item => item.id));

        if (expected_ids.size !== actual_ids.size ||
          ![...expected_ids].every(id => actual_ids.has(id))) {
          console.warn('Incremental update mismatch, using full save');
          updated_items = items;
        }

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

          // Verify the temporary file was written correctly
          try {
            const temp_contents = await readFile(temp_filename, { baseDir: base_dir });
            const temp_text = decoder.decode(temp_contents);
            if (temp_text !== data_to_save) {
              throw new Error('Temp file verification failed');
            }
          } catch (verifyError) {
            // If verification fails, continue anyway for compatibility
            console.warn(`Failed to verify temporary file ${temp_filename}:`, verifyError);
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
          try {
            // Clone data to prevent mutation in callback
            const callback_data = { items: cloneForCallback(updated_items) };
            await change_callback(callback_data);
          } catch (callbackError) {
            if (security.propagateCallbackErrors) {
              throw new Error(`Change callback failed for ${filename}`, { cause: callbackError });
            } else {
              console.warn(`Change callback error for ${filename}:`, callbackError);
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
  }) as PersistenceAdapter<T, ID>;
}

export { createEncryption } from './encryption';
export type { EncryptFunction, DecryptFunction, EncryptedPayload, SecurityOptions, AdapterOptions, EncryptionOptions, EncryptionPair } from './types';
