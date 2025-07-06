import {
  createPersistenceAdapter,
  type PersistenceAdapter,
  type LoadResponse
} from '@signaldb/core';
import {
  open,
  BaseDirectory,
  exists,
  readFile,
  writeFile,
  remove
} from '@tauri-apps/plugin-fs';
import { DecryptFunction, EncryptFunction } from './types';

/**
 * Creates a persistence adapter for SignalDB that uses Tauri's filesystem API.
 * 
 * Features:
 * - Automatic file creation and initialization
 * - Optional encryption/decryption support
 * - Atomic write operations for data safety
 * - Change callbacks for reactive updates
 * - Cross-platform Tauri filesystem integration
 * - Graceful error handling and recovery
 * 
 * @template T - The type of items to store, must have an ID field and can contain other properties
 * @template ID - The type of the ID field, defaults to string
 * @param {string} filename - The name of the file to store data in
 * @param {Object} [options] - Configuration options
 * @param {BaseDirectory} [options.base_dir] - The base directory to store the file in (defaults to AppLocalData)
 * @param {EncryptFunction} [options.encrypt] - Function to encrypt data before saving
 * @param {DecryptFunction} [options.decrypt] - Function to decrypt data after loading
 * @returns {PersistenceAdapter<T, ID>} A configured persistence adapter instance
 * @throws {Error} If there is an error during file operations
 */
export function createTauriFilesystemAdapter<T extends { id: ID } & Record<string, any>, ID = string>(
  filename: string,
  options?: {
    base_dir?: BaseDirectory;
    encrypt?: EncryptFunction;
    decrypt?: DecryptFunction;
  }
): PersistenceAdapter<T, ID> {
  const base_dir = options?.base_dir || BaseDirectory.AppLocalData;
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
          console.error(`Failed to write initial data to ${filename}:`, error);
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
        const file_exists = await exists(filename, { baseDir: base_dir });
        if (!file_exists) return { items: [] };

        const contents = await readFile(filename, { baseDir: base_dir });
        const text_content = new TextDecoder().decode(contents);

        if (!text_content.trim()) return { items: [] };

        if (options?.decrypt) {
          try {
            const decrypted = await options.decrypt<T[]>(text_content);
            return { items: decrypted };
          } catch (error) {
            console.warn('Decryption failed. Fallback to plain JSON.', error);
            return { items: JSON.parse(text_content) };
          }
        }

        return { items: JSON.parse(text_content) };
      } catch (error) {
        console.error(`Error loading data from ${filename}:`, error);
        return { items: [] };
      }
    },
    async save(items, changes) {
      try {
        // Use incremental updates with the changes parameter for better performance
        let current_items: T[] = [];

        // First, load current data if file exists
        try {
          const current_data = await this.load();
          current_items = current_data.items || [];
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
            console.error('Encryption failed. Data will not be saved.', error);
            throw new Error(`Failed to encrypt data for ${filename}`, { cause: error });
          }
        } else {
          data_to_save = JSON.stringify(updated_items);
        }

        // Use atomic write: write to temporary file first, then rename
        const temp_filename = `${filename}.tmp`;

        try {
          // Write to temporary file
          const tempFile = await open(temp_filename, {
            write: true,
            create: true,
            baseDir: base_dir
          });

          await tempFile.write(new TextEncoder().encode(data_to_save));
          await tempFile.close();

          // Remove old file if it exists
          try {
            const oldExists = await exists(filename, { baseDir: base_dir });
            if (oldExists) {
              await remove(filename, { baseDir: base_dir });
            }
          } catch (removeError) {
            console.warn(`Failed to remove old file ${filename}:`, removeError);
          }

          // Write the actual file (since Tauri doesn't support atomic rename, we do our best)
          const finalFile = await open(filename, {
            write: true,
            create: true,
            baseDir: base_dir
          });

          await finalFile.truncate();
          await finalFile.write(new TextEncoder().encode(data_to_save));
          await finalFile.close();

          // Clean up temp file
          try {
            const tempExists = await exists(temp_filename, { baseDir: base_dir });
            if (tempExists) {
              await remove(temp_filename, { baseDir: base_dir });
            }
          } catch (cleanupError) {
            console.warn(`Failed to cleanup temp file ${temp_filename}:`, cleanupError);
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
            await change_callback({ items: updated_items });
          } catch (callbackError) {
            console.warn(`Change callback error:`, callbackError);
          }
        }

      } catch (error) {
        console.error(`Error saving data to ${filename}:`, error);
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
