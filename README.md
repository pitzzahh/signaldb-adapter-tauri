# @pitzzahh/signaldb-adapter-tauri

[![npm version](https://badge.fury.io/js/@pitzzahh%2Fsignaldb-adapter-tauri.svg?icon=si%3Anpm)](https://badge.fury.io/js/@pitzzahh%2Fsignaldb-adapter-tauri)
[![Test](https://github.com/pitzzahh/signaldb-adapter-tauri/actions/workflows/test.yml/badge.svg)](https://github.com/pitzzahh/signaldb-adapter-tauri/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A robust and secure persistence adapter for [SignalDB](https://github.com/signaldb/signaldb) in Tauri applications. Seamlessly persist your reactive data collections to the local filesystem with optional encryption support.

## ✨ Features

- 🚀 **Zero Configuration** - Works out of the box with sensible defaults
- 💾 **Native Tauri Integration** - Uses Tauri's secure filesystem API
- 🔐 **Optional Encryption** - Protect your data with custom encryption functions
- 📱 **Cross-Platform** - Works on Windows, macOS, and Linux
- 🛡️ **Type Safe** - Full TypeScript support with comprehensive type definitions
- ⚡ **Zero Dependencies** - No runtime dependencies, maximum performance
- 🔄 **Auto-Recovery** - Graceful fallback for corrupted or encrypted data files

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

### With Custom Base Directory

```typescript
import { BaseDirectory } from '@tauri-apps/api/path';
import { createTauriFileSystemAdapter } from '@pitzzahh/signaldb-adapter-tauri';

const adapter = createTauriFileSystemAdapter('app-data.json', {
  base_dir: BaseDirectory.AppConfig // Store in app config directory
});
```

## 🔐 Encryption & Security

Protect sensitive data with custom encryption functions:

```typescript
import CryptoJS from 'crypto-js';

const adapter = createTauriFileSystemAdapter('secure-data.json', {
  encrypt: async (data) => {
    const encrypted = CryptoJS.AES.encrypt(
      JSON.stringify(data), 
      'your-secret-key'
    ).toString();
    return encrypted;
  },
  decrypt: async (encryptedData) => {
    const decrypted = CryptoJS.AES.decrypt(
      encryptedData, 
      'your-secret-key'
    ).toString(CryptoJS.enc.Utf8);
    return JSON.parse(decrypted);
  }
});
```

### Simple Base64 Encoding (for demo purposes)

```typescript
const adapter = createTauriFileSystemAdapter('data.json', {
  encrypt: async (data) => btoa(JSON.stringify(data)),
  decrypt: async (encoded) => JSON.parse(atob(encoded))
});
```

## 📋 API Reference

### `createTauriFilesystemAdapter(filename, options?)`

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
| `encrypt` | `EncryptFunction` | `undefined` | Custom encryption function |
| `decrypt` | `DecryptFunction` | `undefined` | Custom decryption function |

#### Type Definitions

```typescript
type EncryptFunction = <T>(data: T) => Promise<string>;
type DecryptFunction = <T>(encrypted: string) => Promise<T>;

interface AdapterOptions {
  base_dir?: BaseDirectory;
  encrypt?: EncryptFunction;
  decrypt?: DecryptFunction;
}
```

## 🏗️ Complete Example

Here's a comprehensive example showing how to build a todo app with encrypted persistence:

```typescript
import { Collection } from '@signaldb/core';
import { createTauriFileSystemAdapter } from '@pitzzahh/signaldb-adapter-tauri';
import { BaseDirectory } from '@tauri-apps/api/path';
import CryptoJS from 'crypto-js';

interface Todo {
  id: string;
  title: string;
  completed: boolean;
  createdAt: Date;
}

// Create encrypted persistence adapter
const todosAdapter = createTauriFileSystemAdapter('todos.json', {
  base_dir: BaseDirectory.AppLocalData,
  encrypt: async (data) => {
    return CryptoJS.AES.encrypt(
      JSON.stringify(data), 
      'my-app-secret-key'
    ).toString();
  },
  decrypt: async (encryptedData) => {
    const decrypted = CryptoJS.AES.decrypt(
      encryptedData, 
      'my-app-secret-key'
    ).toString(CryptoJS.enc.Utf8);
    return JSON.parse(decrypted);
  }
});

// Create the collection
const todos = new Collection<Todo>({
  name: 'todos',
  persistence: todosAdapter
});

// Use your collection
const newTodo = {
  id: crypto.randomUUID(),
  title: 'Learn SignalDB with Tauri',
  completed: false,
  createdAt: new Date()
};

todos.insert(newTodo);

// Data is automatically encrypted and saved to:
// ~/.local/share/com.yourapp.dev/todos.json (Linux)
// %APPDATA%/com.yourapp.dev/todos.json (Windows)
// ~/Library/Application Support/com.yourapp.dev/todos.json (macOS)
```

## 🛠️ Requirements

- **Tauri**: v2.0 or higher
- **SignalDB**: v1.0 or higher  
- **Node.js**: v18.0 or higher
- **TypeScript**: v5.0 or higher (optional but recommended)

> **Note**: This adapter has zero runtime dependencies. All required packages (`@tauri-apps/api`, `@tauri-apps/plugin-fs`, and `@signaldb/core`) are peer dependencies that should already be installed in your Tauri + SignalDB project.

## 📂 Storage Locations

The adapter stores files in platform-specific directories:

| Platform | Default Location |
|----------|------------------|
| **Linux** | `~/.local/share/[app-name]/` |
| **Windows** | `%APPDATA%/[app-name]/` |
| **macOS** | `~/Library/Application Support/[app-name]/` |

## 🔧 Error Handling

The adapter includes comprehensive error handling:

- **File Creation**: Automatically creates files and directories if they don't exist
- **Encryption Errors**: Falls back to plain JSON if encryption fails
- **Decryption Errors**: Gracefully handles corrupted encrypted data
- **File System Errors**: Provides detailed error messages for debugging

## 🧪 Testing

```bash
# Run the test suite
bun test
```

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
