# signaldb-adapter-tauri

[![npm version](https://img.shields.io/npm/v/@pitzzahh/signaldb-adapter-tauri?logo=npm)](https://www.npmjs.com/package/@pitzzahh/signaldb-adapter-tauri)
[![Test](https://github.com/pitzzahh/signaldb-adapter-tauri/actions/workflows/test.yml/badge.svg)](https://github.com/pitzzahh/signaldb-adapter-tauri/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Filesystem persistence for [SignalDB](https://github.com/maxnowack/signaldb) in Tauri apps. One line per collection, with optional AES-256-GCM encryption.

5.86 KB minified (adapter only, 2.46 KB for encryption). Zero runtime dependencies.

## Install

```bash
npm install @pitzzahh/signaldb-adapter-tauri
```

```bash
bun add @pitzzahh/signaldb-adapter-tauri
```

Peer dependencies (already in your Tauri + SignalDB project):

- `@signaldb/core` 1.x
- `@tauri-apps/api` 2.x
- `@tauri-apps/plugin-fs` 2.x

## Quick start

```typescript
import { Collection } from '@signaldb/core';
import { adapter } from '@pitzzahh/signaldb-adapter-tauri';

const users = new Collection({
  name: 'users',
  persistence: adapter('users.json')
});

users.insert({ name: 'John Doe', email: 'john@example.com' });
```

That stores plaintext. For anything beyond throwaway local state, add encryption from the next section.

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

`createEncryption` uses AES-256-GCM with PBKDF2 key derivation (100k iterations by default, configurable). Each write gets a fresh salt and IV, so identical data never produces identical files. Tampered files fail decryption instead of loading garbage.

Key rotation uses versioned passphrases. Old versions keep decrypting legacy files while new writes use the current key:

```typescript
import { createEncryption } from '@pitzzahh/signaldb-adapter-tauri/encryption';

const { encrypt, decrypt } = createEncryption(
  { 1: 'old-passphrase', 2: 'new-passphrase' },
  { version: 2 }
);
```

One honest warning: encryption only helps if the key is not sitting next to the data. Do not hardcode the passphrase. Prompt the user for it or keep it in the OS keychain (for example via `tauri-plugin-stronghold`). You can also bring your own `encrypt`/`decrypt` functions if you already have a key management story.

## Behavior worth knowing

- **Atomic writes.** Each save goes to a temp file, then renames over the original. A crash mid-write leaves the previous version intact.
- **Serialized saves.** Concurrent `save()` calls run in order through a queue, so they cannot interleave read-modify-write and drop updates.
- **Missing files start empty.** A corrupt plaintext file loads as empty with a loud console warning. Encrypted files fail loudly instead of guessing.
- **Flat filenames only.** No paths, no `..`, no reserved device names (`CON`, `NUL`, ...). One file per collection, in one base directory.
- **Backups are off by default.** Frequent sync writes would pile up backup files, so set `security.createBackups: true` only if you want timestamped copies before each save.
- **Passing validation is on by default.** Decrypted data must be an array unless you supply a custom `dataValidator` or disable the check.

## API

### `adapter(filename, options?)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filename` | `string` | yes | File to store data in. Flat name, no paths |
| `options` | `AdapterOptions` | no | Configuration options |

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `base_dir` | `BaseDirectory` | `AppLocalData` | Tauri base directory for file storage |
| `encrypt` | `(data: T[]) => Promise<string>` | `undefined` | Custom encryption function |
| `decrypt` | `(encrypted: string) => Promise<T[]>` | `undefined` | Custom decryption function |
| `security` | `Partial<SecurityOptions>` | `{}` | Security configuration options |

```typescript
export interface SecurityOptions {
  /** Throw if encrypt/decrypt are missing */
  enforceEncryption: boolean;
  /** Fall back to plaintext parse when decryption fails (downgrade risk, default false) */
  allowPlaintextFallback: boolean;
  /** Validate decrypted data structure (default true) */
  validateDecryptedData: boolean;
  /** Throw change-callback errors instead of logging them */
  propagateCallbackErrors: boolean;
  /** Custom data validator function */
  dataValidator: <T>(data: unknown) => data is T[];
  /** Write timestamped backups before each save (default false) */
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
- `save()` refuses to overwrite when it cannot read the current file, instead of destroying data.
- Passphrases and keys are held as non-extractable `CryptoKey`s and never written to disk by the adapter.

What stays your job:

- Storing the passphrase (user input or OS keychain, never hardcoded).
- Scoping Tauri fs permissions to your app data directory.
- Leaving `allowPlaintextFallback: false` unless you are mid-migration. Setting it true lets an attacker downgrade an encrypted store to plaintext by swapping the file.

Found a vulnerability? Do not open a public issue. Email `araopeterj@gmail.com` with `[SECURITY]` in the subject. See [SECURITY.md](SECURITY.md) for timelines.

## Contributing

Bug reports and pull requests are welcome. For anything beyond a small fix, open an issue first so we agree on direction before you write code.

## License

MIT. See [LICENSE](LICENSE).
