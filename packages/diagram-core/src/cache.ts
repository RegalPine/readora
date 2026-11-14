/**
 * 图表结果缓存（ARC-003 §11.3、F04-055）。
 *
 * 缓存键的四要素决定了「什么时候必须重算」：
 * 源码变、引擎版本变、影响布局的配置变、字体变 —— 只有颜色变不失效，
 * 因为主题走 CSS 变量求值（§8.4），重算纯属浪费。
 */
import type { DiagramRenderOptions } from "./types";

export interface DiagramCacheKey {
  sourceHash: string;
  peleVersion: string;
  optionsHash: string;
  fontVersion: string;
}

/** 与 markdown-core 的 computeContentHash 同构的本地实现：包间不互相依赖。 */
export function hashDiagramSource(source: string): string {
  // FNV-1a 32bit：够用作缓存键，不参与任何安全判定。
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 只取影响布局的选项；maxWidth / 字号 / 字族变化才需要重排。 */
export function layoutOptionsHash(options: DiagramRenderOptions | undefined): string {
  if (!options) {
    return "default";
  }
  const parts = [
    `mw=${options.maxWidth ?? ""}`,
    `fs=${options.fontSize ?? ""}`,
    `ff=${options.fontFamily ?? ""}`,
    `id=${options.idPrefix ?? ""}`
  ];
  return hashDiagramSource(parts.join("|"));
}

export function diagramCacheKey(input: {
  source: string;
  engineVersion: string;
  options?: DiagramRenderOptions | undefined;
  fontVersion?: string | undefined;
}): string {
  const key: DiagramCacheKey = {
    sourceHash: hashDiagramSource(input.source),
    peleVersion: input.engineVersion,
    optionsHash: layoutOptionsHash(input.options),
    fontVersion: input.fontVersion ?? "default"
  };
  return [key.sourceHash, key.peleVersion, key.optionsHash, key.fontVersion].join(":");
}

export interface DiagramCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  invalidate(key: string): void;
  clear(): void;
  readonly size: number;
}

/** 有界 LRU：Map 的插入序即访问序，命中后重插以推到最新。 */
export function createDiagramCache<T>(capacity = 64): DiagramCache<T> {
  const entries = new Map<string, T>();
  return {
    get(key) {
      const value = entries.get(key);
      if (value === undefined) {
        return undefined;
      }
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      if (entries.has(key)) {
        entries.delete(key);
      }
      entries.set(key, value);
      while (entries.size > capacity) {
        const oldest = entries.keys().next();
        if (oldest.done === true) {
          break;
        }
        entries.delete(oldest.value);
      }
    },
    invalidate(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    }
  };
}
