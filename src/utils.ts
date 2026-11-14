export const eMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
// Marks an encrypt/decrypt pair whose decrypt(encrypt(x)) equals
// JSON.parse(JSON.stringify(x)). Symbol.for so the separately bundled
// encryption entry and the adapter agree on it.
export const JSON_CODEC = Symbol.for('signaldb-adapter-tauri:json');
export const isJsonCodec = (fn: unknown): boolean =>
  typeof fn === 'function' && (fn as any)[JSON_CODEC] === true;
