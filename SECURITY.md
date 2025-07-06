# Security Policy

## Supported Versions

We actively maintain and provide security updates for the following versions of `@pitzzahh/signaldb-adapter-tauri`:

| Version | Supported          | Notes                          |
| ------- | ------------------ | ------------------------------ |
| 2.1.x   | :white_check_mark: | Latest stable, recommended     |
| 2.0.x   | :warning:          | Critical security fixes only   |
| 1.x.x   | :x:                | No longer supported            |
| < 1.0   | :x:                | No longer supported            |

### Security Features by Version

- **v2.1.0+**: Comprehensive security hardening with encryption enforcement, path traversal protection, and data validation
- **v2.0.x**: Basic filesystem operations with minimal security features
- **v1.x.x**: Legacy version with known security limitations

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue, please report it responsibly by following these guidelines:

### How to Report

1. **DO NOT** create a public GitHub issue for security vulnerabilities
2. **Email us directly** at: [araopeterj@gmail.com](mailto:araopeterj@gmail.com)
3. **Use the subject line**: `[SECURITY] SignalDB Adapter Vulnerability Report`
4. **Include the following information**:
   - Description of the vulnerability
   - Steps to reproduce the issue
   - Potential impact assessment
   - Suggested fix (if any)
   - Your contact information for follow-up

### What to Expect

- **Initial Response**: Within 48 hours of your report
- **Status Updates**: Every 7 days until resolution
- **Timeline**: 
  - Critical vulnerabilities: Fixed within 7 days
  - High severity: Fixed within 14 days
  - Medium/Low severity: Fixed within 30 days

### Vulnerability Assessment

We classify vulnerabilities based on the actual attack surface of a local filesystem adapter:

#### Critical
- Complete bypass of encryption mechanisms
- Data corruption causing permanent data loss
- Arbitrary file write/read outside the intended application directory

#### High
- Path traversal vulnerabilities allowing access to sensitive system files
- Encryption key exposure or weak encryption implementation
- Race conditions leading to data corruption

#### Medium
- Information disclosure through error messages or logs
- Denial of service through resource exhaustion
- Backup/recovery mechanism failures

#### Low
- Minor information leaks in debug output
- Non-critical crashes that don't affect data integrity
- Performance degradation with potential DoS implications

## Security Best Practices

When using this adapter, follow these security recommendations:

### 1. Encryption
```typescript
// Always use encryption for sensitive data
const adapter = createTauriFileSystemAdapter('data.json', {
  encrypt: yourEncryptFunction,
  decrypt: yourDecryptFunction,
  security: {
    enforceEncryption: true,  // Require encryption
    allowPlaintextFallback: false  // Disable fallback
  }
});
```

### 2. File Paths
```typescript
// Use safe filenames - avoid path traversal
// ✅ Good
createTauriFileSystemAdapter('users.json')
createTauriFileSystemAdapter('app-data.json')

// ❌ Avoid
createTauriFileSystemAdapter('../../../etc/passwd')
createTauriFileSystemAdapter('data\\..\\config.json')
```

### 3. Data Validation
```typescript
// Implement custom data validation
const adapter = createTauriFileSystemAdapter('data.json', {
  security: {
    validateDecryptedData: true,
    dataValidator: (data): data is MyDataType[] => {
      return Array.isArray(data) && data.every(isValidDataStructure);
    }
  }
});
```

### 4. Error Handling
```typescript
// Handle security errors appropriately
try {
  await collection.insert(data);
} catch (error) {
  if (error.message.includes('SECURITY')) {
    // Log security incidents
    console.error('Security violation:', error);
    // Don't expose sensitive details to users
    showUserMessage('Operation failed due to security policy');
  }
}
```

## Security Considerations

### Data Storage
- All data is stored locally using Tauri's secure filesystem API
- Files are written atomically to prevent corruption
- Optional encryption protects data at rest
- Automatic backups prevent data loss

### Path Security
- Filename sanitization prevents path traversal attacks
- Invalid characters and sequences are rejected
- Relative path attempts are blocked

### Memory Safety
- No sensitive data persisted in memory longer than necessary
- Data cloning prevents unintended mutations
- Proper cleanup of temporary variables

## Acknowledgments

We appreciate security researchers who responsibly disclose vulnerabilities. Contributors will be acknowledged in our changelog and can request:

- Public recognition (unless you prefer to remain anonymous)
- Hall of fame mention in our documentation
- Coordination on disclosure timeline
- Technical discussion about the fix

## Contact

For security-related questions or concerns:
- **Email**: [araopeterj@gmail.com](mailto:araopeterj@gmail.com)
- **GitHub**: [@pitzzahh](https://github.com/pitzzahh)

For general questions, please use [GitHub Issues](https://github.com/pitzzahh/signaldb-adapter-tauri/issues).

---

*This security policy is reviewed quarterly and updated as needed. Last updated: July 7, 2025*
