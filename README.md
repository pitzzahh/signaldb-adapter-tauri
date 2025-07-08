# @pitzzahh/signaldb-adapter-tauri

[![npm version](https://img.shields.io/npm/v/@pitzzahh/signaldb-adapter-tauri?logo=npm)](https://www.npmjs.com/package/@pitzzahh/signaldb-adapter-tauri)
[![Test](https://github.com/pitzzahh/signaldb-adapter-tauri/actions/workflows/test.yml/badge.svg)](https://github.com/pitzzahh/signaldb-adapter-tauri/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A simple and reliable persistence adapter for [SignalDB](https://github.com/maxnowack/signaldb) in Tauri applications. Persist your reactive data collections to the local filesystem with optional encryption support.

## ✨ Features

- 🚀 **Zero Configuration** - Works out of the box with sensible defaults
- 💾 **Native Tauri Integration** - Uses Tauri's secure filesystem API
- 🔐 **Optional Encryption** - Protect your data with custom encryption functions
- 📱 **Cross-Platform** - Works on Windows, macOS, and Linux
- 🎯 **Type Safe** - Full TypeScript support with comprehensive type definitions
- ⚡ **Zero Dependencies** - No runtime dependencies, maximum performance
- 🔄 **Auto-Recovery** - Graceful handling of corrupted or missing files

## 📦 Installation

Install the package using your preferred package manager:

```bash
# npm
npm install @pitzzahh/signaldb-adapter-tauri

# yarn
yarn add @pitzzahh/signaldb-adapter-tauri

# pnpm
pnpm add @pitzzahh/signaldb-adapter-tauri

# bun
bun add @pitzzahh/signaldb-adapter-tauri
```

## 🚀 Quick Start

### Basic Usage

```typescript
import { Collection } from '@signaldb/core';
import { createTauriFileSystemAdapter } from '@pitzzahh/signaldb-adapter-tauri';

// Create a collection with filesystem persistence
const users = new Collection({
  name: 'users',
  persistence: createTauriFileSystemAdapter('users.json')
});

// Your data is now automatically persisted to the filesystem!
users.insert({ name: 'John Doe', email: 'john@example.com' });
```

> 📖 **Need more examples?** Check out our [Usage Examples](https://github.com/pitzzahh/signaldb-adapter-tauri/wiki/Usage%E2%80%90Examples) in the wiki.

### With Encryption

```typescript
const adapter = createTauriFileSystemAdapter('secure-data.json', {
  encrypt: async (data) => btoa(JSON.stringify(data)),
  decrypt: async (encoded) => JSON.parse(atob(encoded))
});
```

> 🔐 **Want stronger encryption?** See our [Security Guide](https://github.com/pitzzahh/signaldb-adapter-tauri/wiki/Security%E2%80%90Guide) for production-ready encryption examples.

### With Custom Base Directory

```typescript
import { BaseDirectory } from '@tauri-apps/plugin-fs';

const adapter = createTauriFileSystemAdapter('app-data.json', {
  base_dir: BaseDirectory.AppConfig
});
```

> 📁 **Learn about all storage options:** [Storage Configuration](https://github.com/pitzzahh/signaldb-adapter-tauri/wiki/Storage%E2%80%90Configuration)

##  API Reference

### `createTauriFileSystemAdapter(filename, options?)`

Creates a new persistence adapter instance.

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `filename` | `string` | ✅ | Name of the file to store data in |
| `options` | `AdapterOptions` | ❌ | Configuration options |

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `base_dir` | `BaseDirectory` | `AppLocalData` | Tauri base directory for file storage |
| `encrypt` | `EncryptFunction<T>` | `undefined` | Custom encryption function |
| `decrypt` | `DecryptFunction<T>` | `undefined` | Custom decryption function |
| `security` | `Partial<SecurityOptions>` | `{}` | Security configuration options |

#### Type Definitions

```typescript
export type EncryptFunction<T> = (data: T[]) => Promise<string>;
export type DecryptFunction<T> = (encrypted: string) => Promise<T[]>;

export interface SecurityOptions {
  /** Whether to enforce encryption (throw error if encrypt/decrypt not provided) */
  enforceEncryption: boolean;
  /** Whether to allow fallback to plaintext on decryption failure */
  allowPlaintextFallback: boolean;
  /** Whether to validate decrypted data structure */
  validateDecryptedData: boolean;
  /** Whether callback errors should propagate */
  propagateCallbackErrors: boolean;
  /** Custom data validator function */
  dataValidator: <T>(data: unknown) => data is T[];
  /** Whether to create backup files on save (default: false for sync scenarios) */
  createBackups: boolean;
  /** Maximum number of backup files to keep (default: 5) */
  maxBackups: number;
}

export interface AdapterOptions<T> {
  base_dir?: import('@tauri-apps/plugin-fs').BaseDirectory;
  encrypt?: EncryptFunction<T>;
  decrypt?: DecryptFunction<T>;
  security?: Partial<SecurityOptions>;
}
```

> 📚 **For complete API documentation and advanced configuration options, visit our [Wiki](https://github.com/pitzzahh/signaldb-adapter-tauri/wiki).**

## 🛠️ Requirements

- **Tauri**: v2.0+ with `@tauri-apps/plugin-fs`
- **SignalDB**: v1.0+  
- **Node.js**: v18.0+
- **TypeScript**: v5.0+ (recommended)

> **Note**: This adapter has zero runtime dependencies. All required packages are peer dependencies that should already be installed in your Tauri + SignalDB project.

## 📂 Storage Locations

Files are stored in platform-specific directories:

| Platform | Default Location |
|----------|------------------|
| **Linux** | `~/.local/share/[app-name]/` |
| **Windows** | `%APPDATA%/[app-name]/` |
| **macOS** | `~/Library/Application Support/[app-name]/` |

> 🗂️ **Need help with custom storage locations?** Check our [Storage Configuration Guide](https://github.com/pitzzahh/signaldb-adapter-tauri/wiki/Storage%E2%80%90Configuration).

## 📖 Documentation

For detailed guides and examples, visit our **[Wiki](https://github.com/pitzzahh/signaldb-adapter-tauri/wiki)**:

- 📝 [Usage Examples](https://github.com/pitzzahh/signaldb-adapter-tauri/wiki/Usage%E2%80%90Examples) - Real-world examples and patterns
- 🔐 [Security Guide](https://github.com/pitzzahh/signaldb-adapter-tauri/wiki/Security%E2%80%90Guide) - Encryption best practices and examples
- 📁 [Storage Configuration](https://github.com/pitzzahh/signaldb-adapter-tauri/wiki/Storage%E2%80%90Configuration) - Custom directories and file management
- ⚡ [Performance Tips](https://github.com/pitzzahh/signaldb-adapter-tauri/wiki/Performance%E2%80%90Tips) - Optimization strategies
- 🔧 [Troubleshooting](https://github.com/pitzzahh/signaldb-adapter-tauri/wiki/Troubleshooting) - Common issues and solutions
- 🏗️ [Migration Guide](https://github.com/pitzzahh/signaldb-adapter-tauri/wiki/Migration%E2%80%90Guide) - Upgrading from other adapters

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to discuss what you would like to change.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [SignalDB](https://signaldb.js.org/) - The reactive database this adapter is built for
- [Tauri](https://tauri.app/) - The framework that makes secure desktop apps possible
- [Bun](https://bun.sh/) - The fast JavaScript runtime used for development

---

<div align="center">
  <sub>Built with ❤️ by <a href="https://github.com/pitzzahh">Peter John Arao</a></sub>
</div>
