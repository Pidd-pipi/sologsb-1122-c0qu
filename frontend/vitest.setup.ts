import { vi } from 'vitest';

// JSDOM 缺失时的最小 shim：db.ts 顶层用到 localStorage（设备 id / 地质员）
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as unknown as Storage;
}

// syncRepo.ts 仅在导出时用到浏览器下载
if (typeof globalThis.URL === 'undefined') {
  globalThis.URL = { createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() } as unknown as typeof URL;
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = { createElement: vi.fn(() => ({ click: vi.fn() })) } as unknown as Document;
}
