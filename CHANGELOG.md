# Changelog

## [2.3.0] — Built-in AES-256-GCM encryption

### Added
- **`createEncryption()`** — Built-in encryption utility using Web Crypto API (AES-256-GCM + PBKDF2 with 100k iterations). No external dependencies, available in all Tauri v2 webviews. Drop-in compatible with the adapter's `encrypt`/`decrypt` options.
- **Key rotation support** — Versioned passphrase maps enable seamless key rotation. Old passphrases stay configured for reading legacy data; new writes use the current version.
- **`EncryptedPayload` type** — Documents the on-disk format (`v{version}:{base64(salt ‖ iv ‖ ciphertext+authTag)}`).
- **`EncryptionOptions` and `EncryptionPair` types** — Typed API surface for the encryption utility.
- Comprehensive encryption test suite (`test/encryption.test.ts`) covering round-trips, tampering detection, key rotation, truncation, Unicode, and nested data.

### Fixed
- **README security example** — Replaced the Base64 "encryption" example (encoding, not encryption) with `createEncryption()` — real AES-256-GCM.
- **Wiki Security Guide** — Rewritten to recommend the built-in utility and explicitly warn against HMAC-only and Base64-as-encryption patterns.

### Changed
- `src/types.ts` — Added `EncryptedPayload` interface.
- `src/index.ts` — Re-exports `createEncryption`, `EncryptionOptions`, `EncryptionPair`, and `EncryptedPayload`.

## [2.2.1] — CI & trusted publishing

### Changed
- Switched to npm Trusted Publishing (OIDC) — no more `NPM_TOKEN` secret
- Bumped `actions/checkout` to v7, `actions/setup-node` to v7, `action-gh-release` to v3 for Node 24 runtime
- Test workflow: cancel-in-progress, draft PRs trigger on ready-for-review, added `permissions`
- Auto-create GitHub Release from changelog entry on version bump

## [2.2.0] — Atomic writes & data safety

### Fixed
- **Atomic file writes** — Replaced the `write temp → remove old → write final` pattern with `rename`, which is atomic on most filesystems. Prevents data loss on crash between remove and write.
- **Backup cleanup** — `cleanupOldBackups` was a dead stub that only logged. Now uses `readDir` to list and prune old backups, respecting `maxBackups`.
- **Silent data loss on load failure** — `load()` previously caught ALL read errors and returned `{ items: [] }`, including transient I/O errors. Now only returns empty for genuine file-not-found; re-throws other errors. `save()` no longer falls back to an empty array on load failure — it throws to prevent silently destroying all existing data.
- **Temp file collision** — `Date.now()` produced the same temp filename for concurrent saves in the same millisecond, causing write races. Now uses `crypto.randomUUID()` for unique names.
- **Backup filename collision** — Same `Date.now()` issue; now uses `crypto.randomUUID()` as well.

### Changed
- **Breaking (behavioral)**: `load()` now throws on I/O errors instead of silently returning `{ items: [] }`.
- **Breaking (behavioral)**: `save()` throws `"Refusing to save to prevent data loss"` when it cannot read the current file state, instead of silently destroying all existing data.

### Added
- Comprehensive regression test suite (`test/regression.test.ts`)
- 33 new edge case tests (`test/edge-cases.test.ts`) covering Unicode, optional fields, encryption, callbacks, lifecycle, null/undefined changes, deeply nested data, and more.
- **Bundle size reduction**: Marked peer dependencies as external in build, reducing unpacked size from 23.5 kB → 19.0 kB (gzipped 7.1 kB).

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

### 🛡️ SECURITY IMPROVEMENTS

**Major security hardening release addressing critical vulnerabilities:**

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

### 🔧 Technical Improvements
- Better atomic write operations with verification
- Enhanced temporary file handling with timestamps
- Improved cleanup mechanisms for backup and temporary files
- Comprehensive security test suite

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
