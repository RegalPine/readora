import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      // 只对新落地的 resources 模块设门禁（IMP-001 §14.3）：
      // 既有模块的历史覆盖率不在本批偿还，但新代码从第一天起就必须达标。
      include: ["src/resources/**"],
      exclude: ["src/__stubs__/**", "src/**/__tests__/**"],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 80 }
    }
  }
});