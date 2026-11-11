// Stands in for hyperfy/src/core/storage.js in the sandbox child process: the engine's own module
// reads and writes localstorage.json in the directory above its own, which holds the agent's
// session token.
const data = new Map<string, unknown>();

export const storage = {
  get: (key: string, defaultValue: unknown = null) => data.get(key) ?? defaultValue,
  set: (key: string, value: unknown) => void data.set(key, value),
  remove: (key: string) => void data.delete(key),
};
