import {
  createPersistenceAdapter,
  type PersistenceAdapter,
} from '@signaldb/core';
import {
  open,
  BaseDirectory,
  exists,
  readFile,
  writeFile
} from '@tauri-apps/plugin-fs';
import { DecryptFunction, EncryptFunction } from './types';

/**
 * Creates a persistence adapter for SignalDB that uses Tauri's filesystem API.
 * 
 * @template T - The type of items to store, must have an ID field and can contain other properties
 * @template ID - The type of the ID field, defaults to string
 * @param {string} filename - The name of the file to store data in
 * @param {Object} [options] - Configuration options
 * @param {BaseDirectory} [options.baseDir] - The base directory to store the file in (defaults to AppLocalData)
 * @param {EncryptFunction} [options.encrypt] - Function to encrypt data before saving
 * @param {DecryptFunction} [options.decrypt] - Function to decrypt data after loading
 * @returns {PersistenceAdapter<T, ID> | undefined} A configured persistence adapter instance
 * @throws {Error} If there is an error during file saving
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

  return createPersistenceAdapter({
    async register() {
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
        }
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
        let data_to_save: string;

        if (options?.encrypt) {
          try {
            data_to_save = await options.encrypt<T[]>(items);
          } catch (error) {
            console.error('Encryption failed. Data will not be saved.', error);
            throw error;
          }
        } else {
          data_to_save = JSON.stringify(items);
        }

        const file = await open(filename, {
          write: true,
          create: true,
          baseDir: base_dir
        });

        await file.truncate();
        await file.write(new TextEncoder().encode(data_to_save));
        await file.close();
      } catch (error) {
        console.error(`Error saving data to ${filename}:`, error);
        throw new Error(`Failed to save data to ${filename}`, { cause: error });
      }
    }
  }) as PersistenceAdapter<T, ID>;
}
