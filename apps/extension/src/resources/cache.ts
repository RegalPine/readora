/**
 * 资源解析缓存（ARC-008 §7.4，IMP-001 §14.3 有界缓存要求）。
 *
 * 键含 mtime 与 size，内容变更不可能命中陈旧缓存；
 * 键还含策略版本，改配置后旧条目自然失效。
 * LRU 上限 256，超出即淘汰最久未用，杜绝无界增长。
 */

export const RESOURCE_CACHE_CAPACITY = 256;

export interface ResourceCacheKeyInput {
  /** 规范化后的文件 URI 字符串（不含 query/fragment）。 */
  readonly uri: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly policyVersion: string;
}

export function resourceCacheKey(input: ResourceCacheKeyInput): string {
  return [
    input.uri,
    Math.trunc(input.mtimeMs).toString(36),
    Math.trunc(input.size).toString(36),
    input.policyVersion
  ].join("|");
}

export class ResourceCache<T> {
  private readonly entries = new Map<string, T>();

  constructor(readonly capacity: number = RESOURCE_CACHE_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("ResourceCache capacity must be a positive integer.");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value === undefined) {
      return undefined;
    }
    // 命中后移到末尾，保持最近使用序。
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }

  invalidate(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }
}
