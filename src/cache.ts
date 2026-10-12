import type { CacheStore } from '@whiskeysockets/baileys';

export class LruMap<K, V> extends Map<K, V> {
  constructor(private maximum: number) {
    super();
    if (maximum < 1) throw new Error('Cache size must be positive');
  }
  override get(key: K): V | undefined {
    const value = super.get(key);
    if (super.has(key)) {
      super.delete(key);
      super.set(key, value!);
    }
    return value;
  }
  override set(key: K, value: V): this {
    super.delete(key);
    super.set(key, value);
    if (this.size > this.maximum) super.delete(this.keys().next().value!);
    return this;
  }
}

// Cached signal keys can always be read again from the persistent auth store.
// No sweep timer or disk deletion: expiration and eviction affect only RAM.
export class SignalCache implements CacheStore {
  private entries: LruMap<string, { value: unknown; expires: number }>;
  constructor(
    maximum = 1024,
    private ttlMs = 300_000,
    private now = Date.now,
  ) {
    this.entries = new LruMap(maximum);
  }
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expires <= this.now()) {
      this.entries.delete(key);
      return;
    }
    return entry.value as T;
  }
  set<T>(key: string, value: T) {
    this.entries.set(key, { value, expires: this.now() + this.ttlMs });
  }
  del(key: string) {
    this.entries.delete(key);
  }
  flushAll() {
    this.entries.clear();
  }
  close() {
    this.flushAll();
  }
  get size() {
    return this.entries.size;
  }
}
