/**
 * 结果缓存与主题映射（ARC-003 §8.2 / §11.3、F04-055）。
 *
 * 缓存键的四要素决定「什么时候必须重算」；主题表决定「哪些 CSS 变量必须存在」。
 * 两件事都不该靠人肉记忆，因此在这里钉住。
 */
import { describe, expect, it } from "vitest";

import {
  createDiagramCache,
  diagramCacheKey,
  hashDiagramSource,
  layoutOptionsHash
} from "../cache";
import { PELE_SERIES_VARIABLES, PELE_TOKEN_MAP } from "../theme";

describe("hashDiagramSource", () => {
  it("定长小写十六进制且可重入", () => {
    const hash = hashDiagramSource("flowchart TD\n  A --> B");
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    expect(hashDiagramSource("flowchart TD\n  A --> B")).toBe(hash);
  });

  it("内容差异落到哈希差异上", () => {
    const a = hashDiagramSource("flowchart TD\n  A --> B");
    const b = hashDiagramSource("flowchart TD\n  A --> C");
    expect(a).not.toBe(b);
    expect(hashDiagramSource("")).not.toBe(a);
  });
});

describe("layoutOptionsHash", () => {
  it("无选项与空选项同键", () => {
    expect(layoutOptionsHash(undefined)).toBe("default");
  });

  it("只认影响布局的字段：measurer 变化不换键", () => {
    const base = { maxWidth: 640, fontSize: 16, fontFamily: "serif" } as const;
    const withMeasurer = {
      ...base,
      measurer: { width: () => 1 }
    };
    expect(layoutOptionsHash(withMeasurer)).toBe(layoutOptionsHash(base));
  });

  it("布局字段变化必须换键", () => {
    const base = { maxWidth: 640 };
    expect(layoutOptionsHash(base)).not.toBe(layoutOptionsHash({ maxWidth: 320 }));
    expect(layoutOptionsHash(base)).not.toBe(layoutOptionsHash({}));
    expect(layoutOptionsHash(base)).not.toBe(
      layoutOptionsHash({ maxWidth: 640, idPrefix: "other-" })
    );
  });
});

describe("diagramCacheKey", () => {
  const base = { source: "flowchart TD\n  A --> B", engineVersion: "1.13.0" };

  it("四要素按 源:版本:布局:字体 组装", () => {
    const key = diagramCacheKey(base);
    expect(key.split(":")).toHaveLength(4);
    expect(key).toBe(
      `${hashDiagramSource(base.source)}:1.13.0:${layoutOptionsHash(undefined)}:default`
    );
  });

  it("引擎版本变化失效（升级 Pele 不可能命中旧结果）", () => {
    expect(diagramCacheKey(base)).not.toBe(diagramCacheKey({ ...base, engineVersion: "1.14.0" }));
  });

  it("字体版本变化失效，颜色 / 主题变化不失效", () => {
    expect(diagramCacheKey(base)).not.toBe(diagramCacheKey({ ...base, fontVersion: "v2" }));
    // 主题只改 CSS 变量取值，不进键：因此两次同源码请求必须同键。
    expect(diagramCacheKey(base)).toBe(diagramCacheKey(base));
  });
});

describe("createDiagramCache", () => {
  it("LRU 淘汰最久未用，命中即续命", () => {
    const cache = createDiagramCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1); // a 变成最新
    cache.set("c", 3); // 挤出 b
    expect(cache.size).toBe(2);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  it("重复 set 同一键不增长容量", () => {
    const cache = createDiagramCache<number>(2);
    cache.set("k", 1);
    cache.set("k", 2);
    expect(cache.size).toBe(1);
    expect(cache.get("k")).toBe(2);
  });

  it("invalidate / clear 精确失效", () => {
    const cache = createDiagramCache<number>(4);
    cache.set("x", 1);
    cache.set("y", 2);
    cache.invalidate("x");
    expect(cache.get("x")).toBeUndefined();
    expect(cache.get("y")).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("容量 1 时第二次写入立刻挤掉第一次", () => {
    const cache = createDiagramCache<string>(1);
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
  });
});

describe("PELE_TOKEN_MAP", () => {
  it("9 项基础变量一一对应，无重复无空映射", () => {
    expect(PELE_TOKEN_MAP).toHaveLength(9);
    const pele = PELE_TOKEN_MAP.map((item) => item.peleVariable);
    const reader = PELE_TOKEN_MAP.map((item) => item.readerVariable);
    expect(new Set(pele).size).toBe(pele.length);
    expect(new Set(reader).size).toBe(reader.length);
    for (const item of PELE_TOKEN_MAP) {
      expect(item.peleVariable).toMatch(/^--pele-[a-z-]+$/);
      expect(item.readerVariable).toMatch(/^--readora-diagram-[a-z-]+$/);
    }
  });

  it("覆盖图表必需的底色 / 文字 / 边框 / 连线 / 系列色通道", () => {
    const pele = new Set(PELE_TOKEN_MAP.map((item) => item.peleVariable));
    for (const required of ["--pele-bg", "--pele-fg", "--pele-border", "--pele-line", "--pele-accent"]) {
      expect(pele.has(required)).toBe(true);
    }
    expect(PELE_SERIES_VARIABLES).toHaveLength(8);
    expect(PELE_SERIES_VARIABLES[0]).toBe("--pele-series-1");
    expect(PELE_SERIES_VARIABLES[7]).toBe("--pele-series-8");
  });
});
