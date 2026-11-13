import {
  createStorageAdapter,
  get as getFieldValue,
  serializeValue,
  type StorageAdapter,
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

/** Present-but-unreadable file: reads map it to empty, writes refuse it. */
class CorruptDataError extends Error {
  constructor(filename: string, cause: unknown) {
    super(`Corrupt data in ${filename}`, { cause });
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function validateFilename(filename: string): void {
  if (!filename || typeof filename !== 'string') {
    throw new Error('Filename must be a non-empty string');
  }
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('Invalid filename: path traversal detected');
  }
  // eslint-disable-next-line no-control-regex
  if (/[\0-\x1f<>:"|?*]/.test(filename)) {
    throw new Error('Invalid filename: illegal or control characters');
  }
  // Trailing dots/spaces are stripped silently on Windows.
  if (filename === '.' || /[. ]$/.test(filename)) {
    throw new Error('Invalid filename: reserved or trailing-dot name');
  }
  if (WINDOWS_RESERVED.test(filename)) {
    throw new Error('Invalid filename: reserved device name');
  }
  if (filename.length > 255) {
    throw new Error('Filename too long');
  }
}

function defaultDataValidator<T>(data: unknown): data is T[] {
  return Array.isArray(data);
}

function createBackupFilename(filename: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${filename}.backup.${timestamp}.${crypto.randomUUID()}`;
}

async function listBackups(
  filename: string,
  baseDir: BaseDirectory
): Promise<string[]> {
  const entries = await readDir('.', { baseDir });
  const prefix = `${filename}.backup.`;
  // Newest first; ISO timestamps sort lexicographically.
  return entries
    .filter(entry => entry.name.startsWith(prefix))
    .map(entry => entry.name)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/**
 * SignalDB storage adapter backed by Tauri's filesystem API.
 * One JSON array file per collection, with optional AES-256-GCM encryption,
 * atomic writes, and backups. On-disk format is unchanged from 3.x.
 */
export function adapter<T extends { id: ID } & Record<string, any>, ID = string>(
  filename: string,
  options?: AdapterOptions<T>
): StorageAdapter<T, ID> {
  validateFilename(filename);

  const base_dir = options?.base_dir || BaseDirectory.AppLocalData;
  const security: SecurityOptions = {
    enforceEncryption: false,
    allowPlaintextFallback: false,
    validateDecryptedData: true,
    dataValidator: defaultDataValidator,
    createBackups: false,
    maxBackups: 5,
    ...options?.security
  };

  if (!options?.encrypt && !security.enforceEncryption) {
    console.warn(`[SECURITY] No encryption for ${filename}. Plaintext stored.`);
  }

  if (security.createBackups) {
    console.info(`[INFO] Backups enabled for ${filename}.`);
  }

  if (security.enforceEncryption && (typeof options?.encrypt !== 'function' || typeof options?.decrypt !== 'function')) {
    throw new Error(
      'Encryption enforced but encrypt/decrypt not provided.',
    );
  }

  if ((options?.encrypt != null) !== (options?.decrypt != null)) {
    throw new Error(
      'encrypt and decrypt must be provided together.',
    );
  }

  const validate = (data: unknown, msg: string) => {
    if (security.validateDecryptedData && !(security.dataValidator || defaultDataValidator)(data)) {
      throw new Error(msg);
    }
  };

  // No index files on disk; readIndex builds the answer from file data.
  const createdIndexes = new Set<string>();
  // Cached readIndex results, cleared on every successful write.
  const indexCache = new Map<string, Map<string | null, Set<ID>>>();
  // Backup names known to this instance (newest first). Seeded once from
  // the directory so per-write pruning needs no readDir scan.
  let knownBackups: string[] | null = null;
  // Serializes read-modify-write so concurrent writes cannot lose updates.
  let writeQueue: Promise<void> = Promise.resolve();

  const readItemsInternal = async (): Promise<T[]> => {
    try {
      let contents: Uint8Array;
      try {
        contents = await readFile(filename, { baseDir: base_dir });
      } catch (error) {
        // Only a missing file reads as empty; I/O errors propagate. The
        // message match covers known backends; exists() disambiguates the
        // rest, so an unfamiliar "not found" wording cannot wedge reads.
        const msg = eMsg(error).toLowerCase();
        if (msg.includes('not found') || msg.includes('no such file')) {
          return [];
        }
        const stillThere = await exists(filename, { baseDir: base_dir }).catch(() => true);
        if (!stillThere) return [];
        throw error;
      }

      const text_content = decoder.decode(contents);
      if (text_content.length === 0 || !/\S/.test(text_content)) return [];

      let decrypted_data: T[];

      if (options?.decrypt) {
        try {
          decrypted_data = await options.decrypt(text_content);
          validate(decrypted_data, 'Decrypted data failed validation');
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
            validate(decrypted_data, 'Fallback plaintext data failed validation');
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
          validate(decrypted_data, 'Data failed validation');
        } catch (parseError) {
          if (eMsg(parseError).includes('validation')) {
            throw parseError;
          }
          throw new CorruptDataError(filename, parseError);
        }
      }

      return decrypted_data;
    } catch (error) {
      if (error instanceof CorruptDataError) throw error;
      const errorMsg = eMsg(error);
      // Validation and fail-closed decrypt errors must not gain a wrapper.
      if (errorMsg.includes('validation') ||
        errorMsg.includes('Decryption failed, plaintext fallback disabled')) {
        throw error;
      }
      throw new Error(`Failed to load ${filename}: ${errorMsg}`, { cause: error });
    }
  };

  const readItems = async (): Promise<T[]> => {
    try {
      return await readItemsInternal();
    } catch (error) {
      if (error instanceof CorruptDataError) {
        console.warn(`[DATA] Corrupt JSON in ${filename}, loading as empty.`, error.cause ?? error);
        return [];
      }
      throw error;
    }
  };

  const writeItems = async (items: T[]): Promise<void> => {
    if (security.createBackups) {
      const backup_filename = createBackupFilename(filename);
      try {
        const current_content = await readFile(filename, { baseDir: base_dir });
        await writeFile(backup_filename, current_content, { baseDir: base_dir });
        const max = security.maxBackups ?? 5;
        if (knownBackups === null) {
          try {
            knownBackups = await listBackups(filename, base_dir);
            if (!knownBackups.includes(backup_filename)) {
              knownBackups.unshift(backup_filename);
            }
          } catch (error) {
            console.warn(`Failed to cleanup old backups for ${filename}:`, error);
            knownBackups = [backup_filename];
          }
        } else {
          knownBackups.unshift(backup_filename);
        }
        const excess = knownBackups.slice(max);
        if (excess.length) {
          const surviving: string[] = [];
          for (const name of excess) {
            try {
              await remove(name, { baseDir: base_dir });
            } catch (removeError) {
              console.warn(`Failed to remove old backup ${name}:`, removeError);
              surviving.push(name);
            }
          }
          knownBackups = knownBackups.slice(0, max).concat(surviving);
        }
      } catch (backupError) {
        console.warn(`Failed to create backup ${backup_filename}:`, backupError);
      }
    }

    let data_to_save: string;

    if (options?.encrypt) {
      try {
        data_to_save = await options.encrypt(items);
      } catch (error) {
        throw new Error(`Failed to encrypt data for ${filename}`, { cause: error });
      }
    } else {
      data_to_save = JSON.stringify(items);
    }

    const temp_filename = `${filename}.tmp.${crypto.randomUUID()}`;

    try {
      await writeFile(temp_filename, encoder.encode(data_to_save), {
        baseDir: base_dir
      });

      // A proven content mismatch fails closed; a read-back I/O error warns.
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

      await rename(temp_filename, filename, {
        oldPathBaseDir: base_dir,
        newPathBaseDir: base_dir
      });

    } catch (writeError) {
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
  };

  // A batch gathers updates submitted in the same tick (insertMany fans
  // out this way) under one guard read and one file rewrite, applied in
  // submission order. Sequential awaits always land in separate batches,
  // and every op in a batch shares its fate: all resolve or all reject.
  let openBatch: Array<{
    update: (items: Map<ID, T>) => boolean;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> | null = null;

  // update edits the batch's working map in place and returns whether it
  // changed anything; a batch where nothing changed skips the rewrite.
  const mutate = (update: (items: Map<ID, T>) => boolean): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      if (openBatch) {
        openBatch.push({ update, resolve, reject });
        return;
      }
      const batch = [{ update, resolve, reject }];
      openBatch = batch;
      queueMicrotask(() => {
        openBatch = null;
        const run = async (): Promise<void> => {
          const fail = (error: unknown) => batch.forEach((op) => op.reject(error));
          let current: T[];
          try {
            current = await readItemsInternal();
          } catch (error) {
            fail(new Error(
              `Failed to read ${filename}: refusing to write to prevent data loss.`,
              { cause: error }
            ));
            return;
          }
          // One map per batch keeps k ops at O(n + k), not O(n * k).
          const working = new Map(current.map((item) => [item.id, item]));
          let dirty = false;
          try {
            for (const op of batch) {
              if (op.update(working)) dirty = true;
            }
          } catch (error) {
            fail(error);
            return;
          }
          if (!dirty) {
            batch.forEach((op) => op.resolve());
            return;
          }
          try {
            await writeItems([...working.values()]);
            indexCache.clear();
          } catch (error) {
            fail(error);
            return;
          }
          batch.forEach((op) => op.resolve());
        };
        const pending = writeQueue.then(run, run);
        writeQueue = pending.catch(() => {});
      });
    });
  };

  // Map.set keeps an existing id in place and appends a new one.
  const upsert = (items: Map<ID, T>, incoming: T[]): boolean => {
    for (const item of incoming) items.set(item.id, item);
    return incoming.length > 0;
  };

  return createStorageAdapter<T, ID>({
    async setup() {
      if (await exists(filename, { baseDir: base_dir })) return;
      try {
        const initial_data = options?.encrypt
          ? await options.encrypt([])
          : JSON.stringify([]);
        await writeFile(filename, encoder.encode(initial_data), {
          baseDir: base_dir
        });
      } catch (error) {
        throw new Error(`Failed to initialize file ${filename}`, { cause: error });
      }
    },
    teardown: async () => {},
    readAll: readItems,
    async readIds(ids) {
      const wanted = new Set(ids);
      return (await readItems()).filter((item) => wanted.has(item.id));
    },
    async createIndex(field) {
      createdIndexes.add(field);
    },
    async dropIndex(field) {
      if (!createdIndexes.delete(field)) {
        throw new Error(`Index on field "${field}" does not exist`);
      }
      indexCache.delete(field);
    },
    async readIndex(field) {
      if (!createdIndexes.has(field)) {
        throw new Error(`Index on field "${field}" does not exist`);
      }
      const cached = indexCache.get(field);
      if (cached) return cached;
      const index = new Map<string | null, Set<ID>>();
      for (const item of await readItems()) {
        // Null/missing values live under the null key; core's null, $exists:false
        // and $ne lookups read it.
        const key = serializeValue(getFieldValue(item, field));
        let ids = index.get(key);
        if (!ids) {
          ids = new Set();
          index.set(key, ids);
        }
        ids.add(item.id);
      }
      indexCache.set(field, index);
      return index;
    },
    insert: (items) => mutate((current) => upsert(current, items)),
    replace: (items) => mutate((current) => upsert(current, items)),
    remove: (items) => mutate((current) => {
      let changed = false;
      for (const item of items) changed = current.delete(item.id) || changed;
      return changed;
    }),
    removeAll: () => mutate((current) => {
      if (current.size === 0) return false;
      current.clear();
      return true;
    }),
  });
}

export type { EncryptedPayload, SecurityOptions, AdapterOptions, EncryptionOptions } from './types';
