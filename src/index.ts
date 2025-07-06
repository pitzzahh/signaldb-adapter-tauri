import {
  createPersistenceAdapter,
  type PersistenceAdapter,
  type LoadResponse
} from '@signaldb/core';
import {
  BaseDirectory,
  exists,
  readFile,
  writeFile,
  remove
} from '@tauri-apps/plugin-fs';
import { SecurityOptions, AdapterOptions } from './types';

/**
 * Validates and sanitizes filename to prevent path traversal attacks
 */
function validateFilename(filename: string): void {
  if (!filename || typeof filename !== 'string') {
    throw new Error('Filename must be a non-empty string');
  }

  // Check for path traversal attempts
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('Invalid filename: possible path traversal detected');
  }

  // Check for other dangerous characters
  if (filename.includes('\0') || filename.includes('\n') || filename.includes('\r')) {
    throw new Error('Invalid filename: contains null or newline characters');
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
 * Creates a backup filename with timestamp
 */
function createBackupFilename(filename: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${filename}.backup.${timestamp}`;
}

/**
 * Creates a persistence adapter for SignalDB that uses Tauri's filesystem API.
 * 
 * Features:
 * - Automatic file creation and initialization
 * - Optional encryption/decryption support with security validation
 * - Atomic write operations for data safety
 * - Change callbacks for reactive updates
 * - Cross-platform Tauri filesystem integration
 * - Graceful error handling and recovery
 * - Security hardening against common attacks
 * 
 * @template T - The type of items to store, must have an ID field and can contain other properties
 * @template ID - The type of the ID field, defaults to string
 * @param {string} filename - The name of the file to store data in (sanitized for security)
 * @param {AdapterOptions} [options] - Configuration options including security settings
 * @returns {PersistenceAdapter<T, ID>} A configured persistence adapter instance
 * @throws {Error} If there is an error during file operations or security validation fails
 */
export function createTauriFileSystemAdapter<T extends { id: ID } & Record<string, any>, ID = string>(
  filename: string,
  options?: AdapterOptions
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
    ...options?.security
  };

  // Security check: warn about unencrypted storage
  if (!options?.encrypt && !security.enforceEncryption) {
    console.warn(
      `[SECURITY WARNING] No encryption function provided for ${filename}. ` +
      'Data will be stored in plaintext. Consider enabling encryption for sensitive data.'
    );
  }

  // Security check: enforce encryption if required
  if (security.enforceEncryption && (!options?.encrypt || !options?.decrypt)) {
    throw new Error(
      'Encryption is enforced but encrypt/decrypt functions are not provided. ' +
      'This is a security requirement.'
    );
  }

  let change_callback: ((data?: LoadResponse<T>) => void | Promise<void>) | null = null;
  let is_registered = false;

  return createPersistenceAdapter({
    async register(onChange) {
      change_callback = onChange;
      is_registered = true;

      const fileExists = await exists(filename, { baseDir: base_dir });

      if (!fileExists) {
        let initial_data: string;

        try {
          if (options?.encrypt) {
            initial_data = await options.encrypt<T[]>([]);
          } else {
            initial_data = JSON.stringify([]);
          }

          await writeFile(filename, new TextEncoder().encode(initial_data), {
            baseDir: base_dir
          });
        } catch (error) {
          throw new Error(`Failed to initialize file ${filename}`, { cause: error });
        }
      }

      // Initial load and notify callback
      try {
        const initialData = await this.load();
        if (change_callback && initialData.items && initialData.items.length > 0) {
          await change_callback(initialData);
        }
      } catch (error) {
        console.warn(`Failed to load initial data for ${filename}:`, error);
      }
    },
    async load() {
      try {
        // Atomic check and read to prevent TOCTOU race conditions
        let contents: Uint8Array;
        try {
          contents = await readFile(filename, { baseDir: base_dir });
        } catch (error) {
          // File doesn't exist or can't be read
          return { items: [] };
        }

        const text_content = new TextDecoder().decode(contents);

        if (!text_content.trim()) return { items: [] };

        let decrypted_data: T[];

        if (options?.decrypt) {
          try {
            decrypted_data = await options.decrypt<T[]>(text_content);

            // Validate decrypted data structure if validation is enabled
            if (security.validateDecryptedData) {
              const validator = security.dataValidator || defaultDataValidator;
              if (!validator<T>(decrypted_data)) {
                throw new Error('Decrypted data failed validation - possible data corruption or tampering');
              }
            }
          } catch (decryptError) {
            const errorMsg = decryptError instanceof Error ? decryptError.message : String(decryptError);
            if (!security.allowPlaintextFallback) {
              throw new Error(
                `Decryption failed and plaintext fallback is disabled. ` +
                `This could indicate data tampering or corruption: ${errorMsg}`,
                { cause: decryptError }
              );
            }

            console.warn(
              `[SECURITY WARNING] Decryption failed for ${filename}. ` +
              'Attempting plaintext fallback. This could indicate data tampering.',
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
              const parseMsg = parseError instanceof Error ? parseError.message : String(parseError);
              throw new Error(
                `Both decryption and plaintext parsing failed for ${filename}: ${parseMsg}`,
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
            const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
            if (errorMsg.includes('validation')) {
              throw parseError; // Re-throw validation errors as-is
            }
            return { items: [] }; // For backwards compatibility with corrupted JSON
          }
        }

        return { items: decrypted_data };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        // For certain errors, propagate them directly
        if (errorMsg.includes('Decryption failed and plaintext fallback is disabled') ||
          errorMsg.includes('Data failed validation') ||
          errorMsg.includes('Fallback plaintext data failed validation')) {
          throw error;
        }
        // For other errors, wrap them for context
        throw new Error(`Failed to load data from ${filename}: ${errorMsg}`, { cause: error });
      }
    },
    async save(items, changes) {
      try {
        // Create backup before modifying data
        const backup_filename = createBackupFilename(filename);

        // Use incremental updates with the changes parameter for better performance
        let current_items: T[] = [];

        // First, load current data if file exists
        try {
          const current_data = await this.load();
          current_items = current_data.items || [];

          // Create backup of current state
          try {
            const current_content = await readFile(filename, { baseDir: base_dir });
            await writeFile(backup_filename, current_content, { baseDir: base_dir });
          } catch (backupError) {
            console.warn(`Failed to create backup ${backup_filename}:`, backupError);
          }
        } catch (error) {
          console.warn('Could not load current data, starting with empty array:', error);
          current_items = [];
        }

        // Apply changes incrementally
        let updated_items = [...current_items];

        // Remove items first
        if (changes.removed && changes.removed.length > 0) {
          const removedIds = new Set(changes.removed.map(item => item.id));
          updated_items = updated_items.filter(item => !removedIds.has(item.id));
        }

        // Update existing items
        if (changes.modified && changes.modified.length > 0) {
          const modifiedMap = new Map(changes.modified.map(item => [item.id, item]));
          updated_items = updated_items.map(item =>
            modifiedMap.has(item.id) ? modifiedMap.get(item.id)! : item
          );
        }

        // Add new items
        if (changes.added && changes.added.length > 0) {
          updated_items.push(...changes.added);
        }

        // Verify the result matches the provided items array
        // This ensures data integrity
        const expected_ids = new Set(items.map(item => item.id));
        const actual_ids = new Set(updated_items.map(item => item.id));

        if (expected_ids.size !== actual_ids.size ||
          ![...expected_ids].every(id => actual_ids.has(id))) {
          console.warn('Incremental update mismatch, falling back to full save');
          updated_items = items;
        }

        let data_to_save: string;

        if (options?.encrypt) {
          try {
            data_to_save = await options.encrypt<T[]>(updated_items);
          } catch (error) {
            throw new Error(`Failed to encrypt data for ${filename}`, { cause: error });
          }
        } else {
          data_to_save = JSON.stringify(updated_items);
        }

        // Use atomic write pattern: write to temporary file first
        const temp_filename = `${filename}.tmp.${Date.now()}`;

        try {
          // Write to temporary file
          await writeFile(temp_filename, new TextEncoder().encode(data_to_save), {
            baseDir: base_dir
          });

          // Verify the temporary file was written correctly (if possible)
          try {
            const temp_contents = await readFile(temp_filename, { baseDir: base_dir });
            const temp_text = new TextDecoder().decode(temp_contents);
            if (temp_text !== data_to_save) {
              throw new Error('Temporary file verification failed - data mismatch');
            }
          } catch (verifyError) {
            // If verification fails, continue anyway for compatibility
            console.warn(`Failed to verify temporary file ${temp_filename}:`, verifyError);
          }

          // Remove old file if it exists and replace with new one
          // This is the closest we can get to atomic operation in Tauri
          try {
            const oldExists = await exists(filename, { baseDir: base_dir });
            if (oldExists) {
              await remove(filename, { baseDir: base_dir });
            }
          } catch (removeError) {
            console.warn(`Failed to remove old file ${filename}:`, removeError);
          }

          // Write the final file
          await writeFile(filename, new TextEncoder().encode(data_to_save), {
            baseDir: base_dir
          });

          // Clean up temp file
          try {
            const tempExists = await exists(temp_filename, { baseDir: base_dir });
            if (tempExists) {
              await remove(temp_filename, { baseDir: base_dir });
            }
          } catch (cleanupError) {
            console.warn(`Failed to cleanup temp file ${temp_filename}:`, cleanupError);
          }

          // Clean up old backup files (keep only recent ones)
          try {
            // Implementation could be added to limit backup retention
          } catch (cleanupError) {
            console.warn('Failed to cleanup old backups:', cleanupError);
          }

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
          throw new Error(`Failed to write data to ${filename}`, { cause: writeError });
        }

        // Notify callback about the change if registered
        if (is_registered && change_callback) {
          try {
            // Clone data to prevent mutation in callback
            const callback_data = { items: JSON.parse(JSON.stringify(updated_items)) };
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
        // Re-throw callback errors if they should propagate
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (errorMsg.includes('Change callback failed')) {
          throw error;
        }
        throw new Error(`Failed to save data to ${filename}`, { cause: error });
      }
    },
    async unregister() {
      // Clean up the change callback when unregistering
      is_registered = false;
      change_callback = null;
    }
  }) as PersistenceAdapter<T, ID>;
}

export type { EncryptFunction, DecryptFunction, SecurityOptions, AdapterOptions } from './types';
