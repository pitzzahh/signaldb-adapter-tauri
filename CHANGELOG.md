# Changelog

## [4.0.0]: SignalDB core 2.x

### Breaking
- **Requires `@signaldb/core` 2.x and Node >=22** (`package.json`). On core 1.x, stay on the 3.x line (`lts-3.1` tag), which keeps getting security fixes. Node 18/20 are EOL; the adapter/targets only use Web APIs stable since Node 18, so the bump is build-time only.
- **`adapter()` returns a `StorageAdapter`** (`src/index.ts`). The v1 `register`/`load`/`save` surface is gone; the adapter now implements `setup`/`teardown`/`readAll`/`readIds`/`insert`/`replace`/`remove`/`removeAll` plus index methods. Construct collections with `new Collection(name, new DefaultDataAdapter({ storage: () => adapter('f.json') }))`.
- **Writes are per-operation, not full-state** (`src/index.ts`). `insert`/`replace` upsert by id, `remove` deletes by id. The save-coalescing from 3.1.0 is gone: skipping a queued write was safe for full-state saves and would lose data for incremental ops. The serialize queue stays, so concurrent writes still cannot interleave.
- **Removed `security.propagateCallbackErrors`** (`src/types.ts`). Storage adapters have no change callbacks, so the option has nothing to do. Passing it is now a type error.
- **Error strings renamed** (`src/index.ts`). `Refusing to save to prevent data loss` is now `refusing to write to prevent data loss`; `Failed to save <file>` is now `Failed to write <file>`, and encrypt failures surface as `Failed to encrypt data for <file>` instead of being wrapped.

### Added
- **`readIds` and index methods** (`src/index.ts`). Indexes are built on demand from the collection file, so there are no sidecar index files. Reading or dropping an index that was never created throws, which makes callers fall back to a full scan instead of answering wrong.
- **No-op writes skip the rewrite** (`src/index.ts`). Empty inputs, removing ids that are not there, and `removeAll` on an empty store return without touching the file. This also skips a PBKDF2 derivation per call on encrypted stores.
- **Same-tick writes batch under one rewrite** (`src/index.ts`). Updates submitted in the same tick, the way `insertMany` fans out, share one guard read and one file rewrite, applied in submission order. A 500-item `insertMany` costs 4 fs calls instead of 2000, and one PBKDF2 derivation instead of 500 on encrypted stores. Sequential awaits are unaffected, and every op in a batch shares its fate: all resolve or all reject. A batch applies its ops to one id-keyed map, so k ops on n stored items cost O(n + k) instead of O(n * k).
- **Decoded snapshot cache** (`src/index.ts`). The adapter remembers the last file contents it read or wrote together with the decoded items. Every read and every write's guard read still reads the file, but identical bytes skip decrypt, parse and validation, so a sequential `await insert(...)` on an encrypted store costs one PBKDF2 derivation instead of two (the real AES-GCM write bench: 37 ms → 17 ms for 20 writes). Different bytes, from an external edit or a second instance on the same file, are always decoded. `readAll`/`readIds` return clones, so editing a returned item cannot leak into the next write. With `createEncryption`, a write keeps its plaintext JSON and the next read parses that instead of decrypting, so it gets exactly what a fresh read returns (a `Date` comes back as a string, `undefined` and functions are dropped). Plain JSON stores have no decrypt to skip, so their writes are parsed from the file on the next read, as before. A custom `encrypt`/`decrypt` pair may change data on the way through, so its writes are always decrypted on the next read.
- **Backups reuse the guard read** (`src/index.ts`). The backup is written from the bytes the write already read, so it costs no extra read and matches the replaced file byte for byte. A missing file has nothing to back up, so the write skips the backup instead of warning.
- **Missing-file detection no longer trusts error strings alone** (`src/index.ts`). When a read fails with an unrecognized message, the adapter asks `exists()` before deciding the file is missing. Known "not found" wordings take the fast path with no extra call.

### Fixed
- **`readIndex` can no longer cache a stale index** (`src/index.ts`). Index results are cached on the snapshot they were built from instead of a cache that writes cleared, so a read that started before a write and finished after it cannot outlive that write.
- **`readIndex` keys null and missing values under `null`** (`src/index.ts`). Core's index lookups for `{ field: null }`, `{ field: { $exists: false } }` and `$ne` read that key; skipping it made those queries return nothing on an indexed field under `AsyncDataAdapter`, `AutoFetchDataAdapter` and `WorkerDataAdapterHost`. `DefaultDataAdapter` never reads indexes and was unaffected.

### Changed
- **No data migration needed.** The on-disk format is byte-identical to 3.x. The official SignalDB adapters all broke their v1 storage layout; this one reads 3.x files as-is.
- **Awaited durability.** With core 2.x, `await collection.insert(...)` resolves after the file lands. The 3.x background-save window is gone.
- **Fail-closed writes kept** (`src/index.ts`). Every mutating op still refuses when the stored file is unreadable or corrupt, and corrupt plaintext still reads as empty with a `[DATA]` warning.
- **Three floating `rejects` assertions now `await`** (`test/hardening.test.ts`), so they actually gate their tests.
- Bundle sizes: `dist/index.js` 6.58 KB, `dist/encryption.js` 2.58 KB (minified).

### Tests
- Suite ported to the v2 API (116 tests): per-op insert/replace/remove coverage, concurrent-write serialization (nothing lost, exact order), same-tick batching (one rewrite per burst, shared fate on failure), real-`Collection` round-trips for both the new constructor and the legacy `persistence` form, `onError`/`ready()` failure paths, and index lifecycle tests.

## [3.1.0]: Fail-closed saves and leaner bundle

### Fail-closed behavior changes
- **Saves to corrupt files are refused** (`src/index.ts`). `load()` still returns empty for corrupt plaintext JSON (backwards compat), but `save()` now throws `Refusing to save…` instead of overwriting the corrupt bytes.
- **`encrypt` and `decrypt` must be provided together** (`src/index.ts`). Half-configured encryption previously wrote ciphertext that `load()` could not parse, losing data on the next save. Construction now throws when only one is given.
- **Temp-file verification mismatch fails the save** (`src/index.ts`). A proven content mismatch previously warned and renamed the bad bytes over the good file; it now warns and throws, leaving the original intact.

### Fixed
- **`maxBackups: 0` ignored** (`src/index.ts`): `|| 5` turned an explicit `0` into `5`; now `?? 5`, so zero keeps no backups.
- **Stale same-id disk content kept on save** (`src/index.ts`): `save()` persists the `items` array directly instead of re-merging incremental changes. Re-merging could only reproduce `items` or keep stale disk content when IDs matched; removing it also drops an O(n) merge plus two ID-set builds per save.

### Changed
- **Concurrent save bursts coalesce** (`src/index.ts`): a queued save superseded by a newer call skips its write; the newest call persists the latest state. Sequential saves are unaffected.
- **Change callbacks no longer block saves** (`src/index.ts`): with default `propagateCallbackErrors: false`, async subscribers settle after the save (data is still `structuredClone`d). Set `propagateCallbackErrors: true` to await and propagate callback errors as before.
- **`createEncryption` caches PBKDF2 key material per passphrase** (`src/encryption.ts`): `importKey` runs once per passphrase instead of per message; per-message `deriveKey` (random salts) is unchanged.
- **PBKDF2 iteration count is immutable per store** (`README.md`, `src/types.ts`): documented that the count is not stored in the payload header, so changing it later makes existing files undecryptable.

### Package
- `package.json` `build` cleans `dist/` first (stale `dist/src/*.d.ts` no longer ship), `size` gates both bundles, `prepublishOnly`/`test:watch`/`test:coverage` scope to `test/` (the bench no longer runs in the publish gate).
- Dropped the `@tauri-apps/api` peer dependency (never imported; `plugin-fs` already depends on it) and refreshed the lockfile (`plugin-fs` 2.7.1).
- Bundle sizes: `dist/index.js` 5.89 KB, `dist/encryption.js` 2.54 KB (minified).

### Tests
- 10 previously floating `expect().rejects` assertions now `await`, so they actually gate their tests.
- New coverage: corrupt-save refusal, half-encryption construction, `maxBackups: 0`, stale-disk overwrite, same-id upsert, cross-iteration decrypt failure, real `Collection` round-trip, and a real-AES-GCM bench case.
- Removed 4 duplicated/debug-only tests and dead `open` mocks.

## [3.0.1]: Stronghold passphrase docs

### Added
- **Stronghold passphrase pattern** (`README.md`): copy-paste example that generates a random passphrase once, keeps it in a Stronghold vault, and unlocks the vault with a user-supplied password. Nothing is embedded in the bundle, so there is nothing to pull out of it by reverse engineering.

## [3.0.0]: Slim bundle and shorter API

### Breaking
- **Renamed `createTauriFileSystemAdapter` to `adapter`** (`src/index.ts:111`). New usage `import { adapter } from '@pitzzahh/signaldb-adapter-tauri'` with `adapter('file.json', opts)`.
- **Encryption moved to subpath** (`src/index.ts:475`, `package.json:40`). Use `import { createEncryption } from '@pitzzahh/signaldb-adapter-tauri/encryption'` instead of the main entry. The main bundle no longer includes `crypto.subtle` and drops from 8.36 KB to 5.86 KB (2.46 KB for `encryption.js`).
- **Removed `EncryptFunction`, `DecryptFunction`, `EncryptionPair` exports** (`src/types.ts:29`, `src/types.ts:66`). Derive from `AdapterOptions` when needed: `NonNullable<AdapterOptions<Todo>['encrypt']>` or `ReturnType<typeof createEncryption>`.

### Changed
- `AdapterOptions` is now the single source for encrypt/decrypt signatures (`src/types.ts:29`), no duplicated type aliases.
- `createEncryption` returns an inline `{ encrypt, decrypt }` pair with generic call-site methods, still drop-in for `adapter`.

### Fixed
- **Forced casts removed**: `as BufferSource` / `as unknown` on Web Crypto calls replaced by proper `BufferSource` typing (`src/encryption.ts:48`); `requireWebCrypto` guard removed (Tauri v2 + Bun always have Web Crypto).
- **Shared runtime helpers**: `eMsg`/`encoder`/`decoder` deduped via `src/utils.ts`, `cloneForCallback` now just `structuredClone` (no JSON fallback).

### Package
- `package.json:7` `exports` adds `"./encryption"` subpath, `sideEffects: false` kept for tree-shaking, `build` now emits `dist/index.js` + `dist/encryption.js` (browser, minified, external peers).
- `README.md:9,30,70,109` updated for `adapter` name, subpath import, and inline `AdapterOptions` docs.

## [2.4.0]: Save queue and validation hardening

### Fixed
- **Lost updates on concurrent saves**: `save()` calls now run in order through a queue, so overlapping read-modify-write cycles cannot drop updates.
- **Destructured methods throwing**: `register`, `load`, and `save` no longer depend on `this` and keep working when destructured.
- **Crash on undefined changes**: `save()` with missing `changes` falls back to a full save instead of throwing on `.removed`.
- **Silent corrupt loads**: corrupt plaintext JSON still loads as empty for compatibility, but now logs a loud `[DATA]` warning.
- **Non-array decrypted payloads**: the built-in `decrypt` rejects payloads that do not decode to an array.
- **Slow base64 on large payloads**: payload encoding is chunked, so multi-hundred-KB collections no longer hit concat and `btoa` limits.
- **Bench teardown race**: the scaling bench wiped the mock FS while saves drained in the background; loops now use unique filenames without mid-run wipes.

### Added
- **Stricter filenames**: control characters, `<>:"|?*`, trailing dots and spaces, bare `.`, and Windows device names (`CON`, `NUL`, `COM1`) are rejected. Dotfiles are still allowed.
- **Passphrase and iteration warnings**: short passphrases (under 12 chars) and PBKDF2 counts under 100k log `[SECURITY]` warnings. Empty passphrases throw.
- **`structuredClone` callback data**: change callbacks receive real `Date` and `Map` instances instead of JSON-flattened copies.
- **Bundle size budget**: `bun run size` fails the build over 15 KB (current: 8.5 KB). `sideEffects: false` added for downstream tree shaking.
- **Hardening test suite** (`test/hardening.test.ts`): 15 tests covering the save queue, destructured methods, strict filenames, weak passphrases, large encrypted payloads, corrupt-file warnings, and rename-failure cleanup.

### Changed
- Build target switched from `node` to `browser`, correct for a Tauri webview. Output size unchanged.
- `enforceEncryption` now checks that `encrypt` and `decrypt` are functions, not just present.
- PBKDF2 comment corrected: 100k is the minimum, OWASP recommends 600k.
- CI runs typecheck and the size budget on every run; publish verifies typecheck, tests, and size before releasing. Installs use `--frozen-lockfile`.
- README rewritten around setup, encryption, and behavior. SECURITY.md review date refreshed.

## [2.3.0]: Built-in AES-256-GCM encryption

### Added
- **`createEncryption()`**: built-in encryption utility using Web Crypto API (AES-256-GCM + PBKDF2 with 100k iterations minimum). No external dependencies, available in all Tauri v2 webviews. Drop-in compatible with the adapter's `encrypt`/`decrypt` options.
- **Key rotation support**: versioned passphrase maps enable key rotation. Old passphrases stay configured for reading legacy data; new writes use the current version.
- **`EncryptedPayload` type**: documents the on-disk format (`v{version}:{base64(salt ‖ iv ‖ ciphertext+authTag)}`).
- **`EncryptionOptions` and `EncryptionPair` types**: typed API surface for the encryption utility.
- Full encryption test suite (`test/encryption.test.ts`) covering round-trips, tampering detection, key rotation, truncation, Unicode, and nested data.

### Fixed
- **README security example**: replaced the Base64 "encryption" example (encoding, not encryption) with `createEncryption()`, real AES-256-GCM.
- **Wiki Security Guide**: rewritten to recommend the built-in utility and explicitly warn against HMAC-only and Base64-as-encryption patterns.

### Changed
- `src/types.ts`: added `EncryptedPayload` interface.
- `src/index.ts`: re-exports `createEncryption`, `EncryptionOptions`, `EncryptionPair`, and `EncryptedPayload`.

## [2.2.1]: CI and trusted publishing

### Changed
- Switched to npm Trusted Publishing (OIDC), so no `NPM_TOKEN` secret is needed
- Bumped `actions/checkout` to v7, `actions/setup-node` to v7, `action-gh-release` to v3 for Node 24 runtime
- Test workflow: cancel-in-progress, draft PRs trigger on ready-for-review, added `permissions`
- Auto-create GitHub Release from changelog entry on version bump

## [2.2.0]: Atomic writes and data safety

### Fixed
- **Atomic file writes**: replaced the `write temp → remove old → write final` pattern with `rename`, which is atomic on most filesystems. Prevents data loss on crash between remove and write.
- **Backup cleanup**: `cleanupOldBackups` was a dead stub that only logged. Now uses `readDir` to list and prune old backups, respecting `maxBackups`.
- **Silent data loss on load failure**: `load()` previously caught ALL read errors and returned `{ items: [] }`, including transient I/O errors. Now only returns empty for genuine file-not-found; re-throws other errors. `save()` no longer falls back to an empty array on load failure. It throws to prevent silently destroying all existing data.
- **Temp file collision**: `Date.now()` produced the same temp filename for concurrent saves in the same millisecond, causing write races. Now uses `crypto.randomUUID()` for unique names.
- **Backup filename collision**: same `Date.now()` issue; now uses `crypto.randomUUID()` as well.

### Changed
- **Breaking (behavioral)**: `load()` now throws on I/O errors instead of silently returning `{ items: [] }`.
- **Breaking (behavioral)**: `save()` throws `"Refusing to save to prevent data loss"` when it cannot read the current file state, instead of silently destroying all existing data.

### Added
- Full regression test suite (`test/regression.test.ts`)
- 33 new edge case tests (`test/edge-cases.test.ts`) covering Unicode, optional fields, encryption, callbacks, lifecycle, null/undefined changes, deeply nested data, and more.
- **Bundle size reduction**: marked peer dependencies as external in build, reducing unpacked size from 23.5 kB to 19.0 kB (gzipped 7.1 kB).

## [2.1.6] - 2025-07-08

### Fixed
- **README updates**: Fixed outdated README content in npm package
- **Documentation links**: Corrected incorrect links to wiki and documentation
- **CI workflow**: Updated GitHub Actions workflow to use bun for installation while publishing with npm

## [2.1.3] - 2025-07-08

### Changed
- **Backup creation disabled by default** - Prevents backup file accumulation during frequent sync operations
- **Added backup configuration options** - `createBackups` and `maxBackups` security settings

### Added
- Backup cleanup mechanism when backups are enabled
- Performance information logging for sync scenarios

## [2.1.2] - 2025-07-08

### Added
- **Bundle size optimization**: Minified bundle from ~29kB to ~20kB (31% reduction)

### Fixed
- **Type inference issues**: Fixed `EncryptFunction` and `DecryptFunction` type definitions to properly handle arrays (`T[]`) instead of single items (`T`)
- **Unnecessary type assertions**: Removed explicit type assertions (`<T[]>`) from encrypt/decrypt function calls as TypeScript now correctly infers the types
- **Better TypeScript support**: Improved type safety and developer experience with proper generic type constraints

## [2.1.1] - 2025-07-06

### Added
- Performance tests for adapter operations

### Fixed
- README npm version badge URL not working correctly (now uses PNG format for consistency) and some information about the package was missing in the README

## [2.1.0] - 2025-07-06

### Security improvements

**Security hardening release addressing critical vulnerabilities:**

#### Breaking Changes
- **Data validation enabled by default** - Invalid data structures will now throw errors instead of being silently accepted
- **Plaintext fallback disabled by default** - Decryption failures will throw errors instead of falling back to plaintext
- **Filename validation enforced** - Path traversal attempts and invalid filenames will throw errors immediately

#### Added Security Features
- **Filename sanitization**: Prevents path traversal attacks (`../`, `..\\`, null bytes, etc.)
- **Encryption enforcement**: Optional `enforceEncryption` security setting
- **Data integrity validation**: Configurable data structure validation with custom validators
- **Secure decryption handling**: No silent fallback to plaintext on decryption failures
- **Race condition mitigation**: Improved atomic file operations to prevent TOCTOU attacks
- **Backup and recovery system**: Automatic timestamped backups before data modifications
- **Callback security**: Data cloning prevents callback mutation, configurable error propagation
- **Enhanced error handling**: Detailed security warnings and explicit error messages

#### New Security Options
```typescript
interface SecurityOptions {
  enforceEncryption?: boolean;          // Require encrypt/decrypt functions
  allowPlaintextFallback?: boolean;     // Allow fallback on decryption failure
  validateDecryptedData?: boolean;      // Validate data structure integrity
  propagateCallbackErrors?: boolean;    // Control callback error handling
  dataValidator?: <T>(data: unknown) => data is T[]; // Custom validation
}
```

#### Migration Guide
- **Enable plaintext fallback if needed**: Set `security: { allowPlaintextFallback: true }`
- **Handle validation errors**: Catch and handle data validation failures appropriately
- **Review filename usage**: Ensure filenames don't contain path separators or invalid characters
- **Update error handling**: Security errors now provide more specific error messages

### Technical improvements
- Better atomic write operations with verification
- Enhanced temporary file handling with timestamps
- Improved cleanup mechanisms for backup and temporary files
- Full security test suite

## [2.0.0] - 2025-07-06

### BREAKING CHANGES

- **Types import path changed**: Types are now exported from the main package entry point instead of a separate `/dist/types` path
  - **Before**: `import { EncryptFunction, DecryptFunction } from '@pitzzahh/signaldb-adapter-tauri/dist/types'`
  - **After**: `import { EncryptFunction, DecryptFunction } from '@pitzzahh/signaldb-adapter-tauri'`

### Changed
- Consolidated all exports to main index file for better developer experience
- Simplified import structure

## [1.0.0] - Initial Release

### Added
- SignalDB persistence adapter for Tauri filesystem
- Optional encryption/decryption support
- Atomic write operations
- Cross-platform filesystem integration
- TypeScript support
