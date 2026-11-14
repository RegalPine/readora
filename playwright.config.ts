/**
 * Playwright 配置（IMP-003 §7.1 功能准入 / §7.2 安全准入，EPIC-11 / EPIC-12）。
 *
 * 三个目录 = 三个 project，而不是一个目录里混着写：
 * - `tests/e2e` 是用户可见行为（点目录、搜索、切主题…），对着 dev 夹具页；
 * - `tests/security` 是威胁模型（CSP、净化、越权路径、非法载荷），对着**生产模板 + 生产 bundle**；
 * - `tests/integration` 是消息协议时序（ready 门控、版本作用域、config.patch 往返）。
 * 分 project 才能让「只跑安全准入」这种取证动作有一条命令，而不是一堆 tag 注释。
 *
 * 不进默认门禁链的理由与视觉基线同一条（README 偏差登记）：它要本机 Chromium。
 * 起不来时 `pnpm test:e2e` 会明确报缺浏览器，不会静默跳过 —— 跳过一支安全用例
 * 比红灯危险得多。
 */
import { defineConfig, devices } from "@playwright/test";

/** 端口可由环境覆盖：本机手工开着 5199 时不必先杀进程。 */
const PORT = Number(process.env.READORA_E2E_PORT ?? 5199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const FIXTURE_URL = `${BASE_URL}/dev/e2e.html`;

export default defineConfig({
  testDir: ".",
  // 只收这三类 spec：`tests/helpers/**` 是共享夹具，不能被当成用例。
  testMatch: [
    "tests/e2e/**/*.spec.ts",
    "tests/security/**/*.spec.ts",
    "tests/integration/**/*.spec.ts"
  ],
  outputDir: "test-results/",
  fullyParallel: true,
  // 单批 30s：真实浏览器里跑一次渲染管线够了；再长就是页面卡死，等下去也没结论。
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["list"], ["json", { outputFile: "test-results/playwright.json" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off"
  },
  webServer: {
    // 夹具页由 Vite dev server 直接托管（与 pnpm visual:* 同一份 dev 入口）。
    // `--host 127.0.0.1` 是必需的：Vite 默认只绑 localhost，而 localhost 在本机
    // 解析到 ::1，`http://127.0.0.1:PORT` 会连不上 —— baseURL 与被测地址必须同族。
    command: `pnpm --filter @readora/webview dev --port ${PORT} --strictPort --host 127.0.0.1`,
    url: FIXTURE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: "ignore",
    stderr: "pipe"
  },
  projects: [
    // 每个 project 只收自己的目录：少了 testMatch，`--project=e2e` 会把三类
    // 用例全跑一遍，「只跑安全准入」这条取证命令就成了假动作。
    {
      name: "e2e",
      testMatch: ["tests/e2e/**/*.spec.ts"],
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "security",
      testMatch: ["tests/security/**/*.spec.ts"],
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "integration",
      testMatch: ["tests/integration/**/*.spec.ts"],
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
