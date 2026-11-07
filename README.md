# signaldb-adapter-tauri

[![npm version](https://img.shields.io/npm/v/@pitzzahh/signaldb-adapter-tauri?logo=npm)](https://www.npmjs.com/package/@pitzzahh/signaldb-adapter-tauri)
[![Test](https://github.com/pitzzahh/signaldb-adapter-tauri/actions/workflows/test.yml/badge.svg)](https://github.com/pitzzahh/signaldb-adapter-tauri/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Filesystem persistence for [SignalDB](https://github.com/maxnowack/signaldb) in Tauri apps. One file per collection, with optional AES-256-GCM encryption.

6.26 KB minified (adapter only, 2.47 KB for encryption). Zero runtime dependencies.

## Install

```bash
npm install @pitzzahh/signaldb-adapter-tauri
```

```bash
bun add @pitzzahh/signaldb-adapter-tauri
```

Peer dependencies (already in your Tauri + SignalDB project):

- `@signaldb/core` 2.x
- `@tauri-apps/api` 2.x
- `@tauri-apps/plugin-fs` 2.x

## Quick start

```typescript
import { Collection, DefaultDataAdapter } from '@signaldb/core';
import { adapter } from '@pitzzahh/signaldb-adapter-tauri';

const dataAdapter = new DefaultDataAdapter({
  storage: () => adapter('users.json')
});

const users = new Collection('users', dataAdapter);
await users.ready();

await users.insert({ name: 'John Doe', email: 'john@example.com' });
```

That stores plaintext. For anything beyond throwaway local state, add encryption from the next section.

Writes are awaited through to disk: `insert` resolves after the file lands, so there is no background-save window where a quit loses data.

## Migrating from 3.x

SignalDB 2.x made collection writes async and replaced persistence adapters with storage adapters. The steps:

1. Upgrade `@signaldb/core` to 2.x.
2. Construct collections with `new Collection(name, dataAdapter)` as above. The old `new Collection({ name, persistence })` form still works but is deprecated.
3. `await` every write. `insert` now resolves to the new id, `updateOne`/`removeOne` to a count.
4. Drop `security.propagateCallbackErrors` if you set it. Storage adapters have no change callbacks, so the option is gone.

Your data files need no migration. The on-disk format is byte-identical to 3.x: point the 4.x adapter at the same filename and it reads what 3.x wrote.

Two error strings changed: `Refusing to save to prevent data loss` is now `refusing to write to prevent data loss`, and `Failed to save <file>` is now `Failed to write <file>` (or the more specific `Failed to encrypt data for <file>`). Update any log filters that match on them.

Still on `@signaldb/core` 1.x? Stay on the 3.x line of this package (`npm install @pitzzahh/signaldb-adapter-tauri@lts-3.1`). It gets security fixes; see SECURITY.md.

## Tauri setup: grant filesystem access

Tauri v2 denies fs access by default, so allow it in a capability file such as `src-tauri/capabilities/default.json`:

```json
{
  "identifier": "main-capability",
  "windows": ["main"],
  "permissions": [
    "fs:allow-exists",
    "fs:allow-read-file",
    "fs:allow-write-file",
    "fs:allow-remove",
    "fs:allow-rename",
    "fs:allow-read-dir",
    {
      "identifier": "fs:scope",
      "allow": ["$APPLOCALDATA/*"]
    }
  ]
}
```

Without these, every read and write fails with a permission error. Keep the scope tight (`$APPLOCALDATA/*`) so the adapter can only touch its own directory. Check the [fs plugin docs](https://tauri.app/plugin/file-system/) if permission names changed since this was written.

## Encryption

```typescript
import { adapter } from '@pitzzahh/signaldb-adapter-tauri';
import { createEncryption } from '@pitzzahh/signaldb-adapter-tauri/encryption';

const { encrypt, decrypt } = createEncryption('user-supplied-passphrase');

const secure = adapter('secure-data.json', {
  encrypt,
  decrypt,
  security: { enforceEncryption: true, allowPlaintextFallback: false }
});
```

`createEncryption` uses AES-256-GCM with PBKDF2 key derivation (100k iterations by default, configurable). Each write gets a fresh salt and IV, so identical data never produces identical files. Tampered files fail decryption instead of loading garbage. Pick the iteration count once per store: it is not stored in the file header, so raising it later makes existing files undecryptable.

Key rotation uses versioned passphrases. Old versions keep decrypting legacy files while new writes use the current key:

```typescript
import { createEncryption } from '@pitzzahh/signaldb-adapter-tauri/encryption';

const { encrypt, decrypt } = createEncryption(
  { 1: 'old-passphrase', 2: 'new-passphrase' },
  { version: 2 }
);
```

One honest warning: encryption only helps if the key is not sitting next to the data. Do not hardcode the passphrase. Prompt the user for it or keep it in the OS keychain (for example via `tauri-plugin-stronghold`). You can also bring your own `encrypt`/`decrypt` functions if you already have a key management story.

### Storing the passphrase with Stronghold

Copy-paste pattern: generate a random passphrase once, keep it in a Stronghold vault, and unlock the vault with a user-supplied password. Nothing is embedded in the bundle, so there is nothing to reverse-engineer out of it.

**1. Register the plugin** in `src-tauri/src/lib.rs` (see the [Stronghold plugin docs](https://tauri.app/plugin/stronghold/) for the current setup):

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_stronghold::Builder::new(|password| {
        // Derive the snapshot key, e.g. with argon2 (see plugin docs).
        // Return the derived key bytes here.
        key.to_vec()
    }).build())
```

Add `"stronghold:default"` to your capability file's `permissions` alongside the fs permissions above.

**2. Load or generate the passphrase** on the frontend:

```typescript
import { Stronghold } from '@tauri-apps/plugin-stronghold';
import { appDataDir } from '@tauri-apps/api/path';
import { adapter } from '@pitzzahh/signaldb-adapter-tauri';
import { createEncryption } from '@pitzzahh/signaldb-adapter-tauri/encryption';

async function loadPassphrase(vaultPassword: string): Promise<string> {
  const stronghold = await Stronghold.load(
    `${await appDataDir()}/vault.hold`,
    vaultPassword, // must come from the user (prompt), never hardcoded
  );
  let client;
  try {
    client = await stronghold.loadClient('signaldb');
  } catch {
    client = await stronghold.createClient('signaldb');
  }
  const store = client.getStore();

  const existing = await store.get('signaldb-passphrase');
  if (existing) return new TextDecoder().decode(existing);

  // First run: generate 256 bits of randomness, store, persist.
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const passphrase = btoa(String.fromCharCode(...bytes));
  await store.insert(
    'signaldb-passphrase',
    Array.from(new TextEncoder().encode(passphrase)),
  );
  await stronghold.save();
  return passphrase;
}

// vaultPassword comes from your login/unlock UI:
const { encrypt, decrypt } = createEncryption(await loadPassphrase(vaultPassword));

const secure = adapter('secure-data.json', {
  encrypt,
  decrypt,
  security: { enforceEncryption: true, allowPlaintextFallback: false },
});
```

Why this shape: the vault password is the only secret the user must remember, and the actual database passphrase is high-entropy randomness no one needs to type. Hardcoding `vaultPassword` instead of prompting would just move the embedded-secret problem one layer down. Don't do that. If a vault is overkill for your app, the simpler secure option is to prompt for the database passphrase on every launch and skip Stronghold entirely.

## Behavior worth knowing

- **Atomic writes.** Each write goes to a temp file, then renames over the original. A crash mid-write leaves the previous version intact.
- **Serialized writes.** Concurrent writes run in order through a queue, so they cannot interleave read-modify-write and drop updates. Writes submitted in the same tick (an `insertMany` burst) share one file rewrite, applied in order. Empty writes (`insert([])`, removing ids that are not there) skip the rewrite entirely.
- **One process per file.** The queue lives in memory, so two processes writing the same file can interleave and lose updates. If your app can launch twice, enforce single-instance (Tauri has a plugin for that).
- **Missing files start empty.** A corrupt plaintext file reads as empty with a loud console warning, but writes to it are refused until the file is fixed or removed. Encrypted files fail loudly instead of guessing.
- **Flat filenames only.** No paths, no `..`, no reserved device names (`CON`, `NUL`, ...). One file per collection, in one base directory.
- **Backups are off by default.** Frequent writes would pile up backup files, so set `security.createBackups: true` only if you want timestamped copies before each write.
- **Data validation is on by default.** Decrypted data must be an array unless you supply a custom `dataValidator` or disable the check.
- **Indexes need no files.** `createIndex`/`readIndex` are answered from the collection file on demand, so there are no sidecar index files to back up or lose.

## API

### `adapter(filename, options?)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filename` | `string` | yes | File to store data in. Flat name, no paths |
| `options` | `AdapterOptions` | no | Configuration options |

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `base_dir` | `BaseDirectory` | `AppLocalData` | Tauri base directory for file storage |
| `encrypt` | `(data: T[]) => Promise<string>` | `undefined` | Custom encryption function (requires `decrypt`) |
| `decrypt` | `(encrypted: string) => Promise<T[]>` | `undefined` | Custom decryption function (requires `encrypt`) |
| `security` | `Partial<SecurityOptions>` | `{}` | Security configuration options |

```typescript
export interface SecurityOptions {
  /** Throw if encrypt/decrypt are missing */
  enforceEncryption: boolean;
  /** Fall back to plaintext parse when decryption fails (downgrade risk, default false) */
  allowPlaintextFallback: boolean;
  /** Validate decrypted data structure (default true) */
  validateDecryptedData: boolean;
  /** Custom data validator function */
  dataValidator: <T>(data: unknown) => data is T[];
  /** Write timestamped backups before each write (default false) */
  createBackups: boolean;
  /** How many backups to keep (default 5) */
  maxBackups: number;
}

export interface AdapterOptions<T> {
  base_dir?: import('@tauri-apps/plugin-fs').BaseDirectory;
  encrypt?: (data: T[]) => Promise<string>;
  decrypt?: (encrypted: string) => Promise<T[]>;
  security?: Partial<SecurityOptions>;
}

// derive function types when needed:
// type EncryptFn<T> = NonNullable<AdapterOptions<T>['encrypt']>;
```

### `createEncryption(passphrases, options?)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `passphrases` | `string \| Record<number, string>` | yes | Passphrase, or version map for rotation |
| `options` | `EncryptionOptions` | no | `{ version?: number, iterations?: number }` |

Returns `{ encrypt, decrypt }`, drop-in compatible with the adapter options above.

## Where files live

| Platform | Default location |
|----------|------------------|
| Linux | `~/.local/share/[app-name]/` |
| Windows | `%APPDATA%/[app-name]/` |
| macOS | `~/Library/Application Support/[app-name]/` |

Pass `base_dir: BaseDirectory.AppConfig` (or another `BaseDirectory`) to store elsewhere.

## Security model

What the adapter guarantees:

- Path traversal is rejected at construction time.
- AES-GCM authentication detects tampering. Modified ciphertext never loads.
- Writes refuse to overwrite when they cannot read the current file, instead of destroying data.
- Passphrases and keys are held as non-extractable `CryptoKey`s and never written to disk by the adapter.

What stays your job:

- Storing the passphrase (user input or OS keychain, never hardcoded).
- Scoping Tauri fs permissions to your app data directory.
- Leaving `allowPlaintextFallback: false` unless you are mid-migration. Setting it true lets an attacker downgrade an encrypted store to plaintext by swapping the file.

Found a vulnerability? Do not open a public issue. Email `hello@peterjohnarao.com` with `[SECURITY]` in the subject. See [SECURITY.md](SECURITY.md) for timelines.

## Contributing

Bug reports and pull requests are welcome. For anything beyond a small fix, open an issue first so we agree on direction before you write code.

## License

MIT. See [LICENSE](LICENSE).
