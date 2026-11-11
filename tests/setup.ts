import 'fake-indexeddb/auto';

// 测试环境的最小 chrome 兼容层（仅覆盖被测模块用到的 API）
const store = new Map<string, unknown>();
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    session: {
      async get(key: string) {
        return { [key]: store.get(key) };
      },
      async set(items: Record<string, unknown>) {
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      },
      async remove(key: string) {
        store.delete(key);
      },
    },
  },
  runtime: {
    sendMessage: async () => ({ ok: true }),
  },
};
