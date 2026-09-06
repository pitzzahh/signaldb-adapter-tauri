export const eMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
