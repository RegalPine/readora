/**
 * DOMPurify 需要真实 DOM，测试环境固定 jsdom（IMP-001 §14 测试矩阵）。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.spec.ts"]
  }
});
