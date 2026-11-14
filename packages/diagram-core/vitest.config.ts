/**
 * diagram-core 测试配置（IMP-001 §14.1）。
 *
 * Pele 需要真实 DOM 结构（createElementNS / SVG 树），因此跑在 jsdom；
 * 文本度量在测试里由注入的 TextMeasurer 承担，不依赖浏览器排版。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      // 本包全部源码入门禁：图表层是 M3 新增的风险面，不允许「只测得着的才算数」。
      include: ["src/**"],
      // types.ts 只有类型，没有任何运行时代码；把它算进分母只会让门禁读数失真。
      exclude: ["src/**/__tests__/**", "src/types.ts", "src/**/*.d.ts"],
      // IMP-001 §14.3：新增模块 80% 阈值，四项一起卡，防止靠少数分支拉高平均值。
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 80 }
    }
  }
});
