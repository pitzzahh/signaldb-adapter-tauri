export type EncryptFunction = <T>(data: T) => Promise<string>;
export type DecryptFunction = <T>(encrypted: string) => Promise<T>;

export { createTauriFilesystemAdapter } from "./index";
