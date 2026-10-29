# Changelog

## [2.1.7] — Security hardening backport

Backports the 2.2.0 data-safety fixes and 2.4.0 adapter hardening to the 2.1.x line (which has no built-in encryption module, so passphrase/payload items do not apply). No API changes. Error and warning message wording now matches newer 2.x releases.

### Fixed
- **Non-atomic writes**: replaced the `write temp → remove old → write final` pattern with `rename`, which is atomic on most filesystems. Prevents data loss on crash between remove and write.
- **Silent data loss on load failure**: `load()` now only returns empty for genuine file-not-found and re-throws other errors. `save()` refuses to overwrite when it cannot read current state.
- **Temp/backup filename collision**: `Date.now()` temp names replaced with `crypto.randomUUID()`.
- **Dead backup cleanup**: `cleanupOldBackups` now lists and prunes old backups via `readDir`, respecting `maxBackups`.
- **Lost updates on concurrent saves**: `save()` calls now run in order through a queue.
- **Encryption enforcement bypass**: `enforceEncryption` now requires `encrypt`/`decrypt` to be functions, not just truthy.
- **Weak filename validation**: control characters, `<>:"|?*`, trailing dots and spaces, bare `.`, and Windows device names (`CON`, `NUL`, `COM1`) are now rejected.
- **Silent corrupt loads**: corrupt plaintext JSON still loads as empty for compatibility, but now logs a loud `[DATA]` warning.
- **Crash on undefined changes**: `save()` with missing `changes` falls back to a full save instead of throwing on `.removed`.
- **Destructured methods throwing**: `register`, `load`, and `save` no longer depend on `this`.

### Added
- Hardening test suite (`test/hardening.test.ts`, 11 tests): save queue, strict filenames, corrupt-file warnings, and rename-failure cleanup.

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
