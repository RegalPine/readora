/**
 * 入站消息的运行时校验（ARC-004 §8.4「Reject Message」/ §8.7，IMP-003 §7.2 安全准入第 6 条）。
 *
 * 单测里 `HostBridge` 是拿假 `MessageSource` 直接喂对象的，能证明分支逻辑；
 * 这里要证明的是**生产 bundle 在真浏览器里**仍然只认那张 Schema —— 打包时的
 * tree-shaking、minify、以及 `MESSAGE_REGISTRY` 的构造顺序都可能改变行为，
 * 而这些只有在「模板 + 产物」这套组合下才看得见。
 *
 * 每条非法消息都配一次「之后仍能收到合法消息」的收尾：只断言「这条没生效」
 * 是不够的，通道被自己弄死也能长红。
 */
import { expect, test } from "@playwright/test";
import { DOCUMENT_TEXT_MAX_LENGTH } from "../../packages/contracts/src/index";
import {
  expectReaderAlive,
  hostMessage,
  loadDocument,
  openProductionReader,
  pageErrors,
  postToView,
  preferences,
  violations
} from "../helpers/production-page";

const VALID_LOAD = hostMessage("document.load", {
  documentUri: "file:///vault/security/other.md",
  languageId: "markdown",
  version: 2,
  text: "# Recovery\n\nValid after the rejects.\n",
  preferences: preferences()
});

/**
 * 被拒的形态矩阵。每一项都必须**只**在自己那一层被拦下：
 * 信封层（形状/版本/类型/方向）与载荷层（strict 对象、类型、区间、长度）。
 */
const REJECTED: [string, unknown][] = [
  // 信封是 strictObject：多余的键（这里塞进一个 `direction`）不是「未知字段忽略」，是整条作废。
  ["信封带未知字段", { ...VALID_LOAD, direction: "host-to-view" }],
  ["信封版本不符", { ...VALID_LOAD, version: 2 }],
  ["信封缺 id", { type: "document.load", version: 1, payload: {} }],
  ["类型不在注册表", { id: "x", type: "document.load2", version: 1, payload: {} }],
  // 方向检查：view→host 的消息名反过来投给 View，不能被当成 host→view 处理。
  ["方向不符（state.save 投给 View）", hostMessage("state.save", { documentUri: "a", state: null })],
  [
    "载荷多余字段",
    hostMessage("config.update", {
      preferences: { ...preferences(), extra: "surprise" }
    })
  ],
  [
    "载荷字段类型错（字号是字符串）",
    hostMessage("config.update", { preferences: { ...preferences(), fontSize: "16" } })
  ],
  [
    "载荷取值越界（字号 999）",
    hostMessage("config.update", { preferences: { ...preferences(), fontSize: 999 } })
  ],
  [
    "载荷枚举越界（字族是自由文本）",
    hostMessage("config.update", { preferences: { ...preferences(), typography: "<script>" } })
  ],
  // 载荷本身是别的类型：`preferences` 少一层包装。
  ["载荷形状错位", hostMessage("config.update", preferences())],
  ["空载荷", hostMessage("document.load", {})],
  ["payload 为 null", hostMessage("theme.update", null)],
  [
    "正文超出长度上限",
    hostMessage("document.load", {
      documentUri: "file:///vault/security/huge.md",
      languageId: "markdown",
      version: 9,
      text: `# Huge\n\n${"x".repeat(DOCUMENT_TEXT_MAX_LENGTH + 1)}`,
      preferences: preferences()
    })
  ],
  // 非对象载荷（字符串/数字）连信封都进不去，也不该把 listener 弄崩。
  ["裸字符串", "document.load"],
  ["null", null]
];

test.describe("入站消息校验", () => {
  test("每条非法消息都被丢弃，且通道之后仍能收合法消息", async ({ page }) => {
    await openProductionReader(page);
    await loadDocument(page, "# First\n\nThis must stay on screen.\n");
    await expect(page.locator(".readora-document h1")).toHaveText("First");

    for (const [label, message] of REJECTED) {
      await postToView(page, message);
      // 非法载荷既不该改界面，也不该在页面里留下异常 —— 后者会走 ErrorBoundary，
      // 那样「拒收」就变成了「把阅读器弄坏」。
      await expect(page.locator(".readora-document h1"), label).toHaveText("First");
    }

    expect(await pageErrors(page)).toEqual([]);
    expect(await violations(page)).toEqual([]);

    // 收尾的对拍照：矩阵跑完，一条合法 load 必须照常生效。
    await postToView(page, VALID_LOAD);
    await expect(page.locator(".readora-document h1")).toHaveText("Recovery");
  });

  test("非法响应信封不会让在途请求把界面带崩", async ({ page }) => {
    await openProductionReader(page);
    await loadDocument(
      page,
      "# Waiting Room\n\nAn image makes the view issue a resource.resolve request.\n\n![local](./assets/shot.png)\n"
    );
    await expectReaderAlive(page);

    // 先确认视图确实发出过请求（否则下面投假响应只是在测空气）。
    const requests = await page.evaluate(() =>
      window.__readoraSecurity.posted.filter(
        (message) => (message as { type?: string }).type === "resource.resolve"
      )
    );
    expect(requests.length).toBeGreaterThan(0);
    const id = (requests[0] as { id: string }).id;

    // 三种「Host 自己发错」：响应缺 success、success 非布尔、id 对不上任何在途请求。
    await postToView(page, { id, payload: {} });
    await postToView(page, { id, success: "true", payload: {} });
    await postToView(page, { id: "never-asked", success: true, payload: {} });

    expect(await pageErrors(page)).toEqual([]);
    await expect(page.locator(".readora-document h1")).toHaveText("Waiting Room");
  });

  test("Host 拒答时页面就地给出原因，不挂在请求超时上", async ({ page }) => {
    // 替身 Host 默认对 resource.resolve 回 `readora.resource.denied`（见 helper）。
    // 页面必须在收到错误响应的那一帧就把图片降级成 missing + 原因，而不是等
    // `REQUEST_TIMEOUT_MS`（10 秒）—— 后者意味着错误分支被当成「还没回」在处理。
    // 用例整体超时是 30 秒，但只要这里等满了超时，本条就会慢到露馅。
    const started = Date.now();
    await openProductionReader(page);
    await loadDocument(page, "# No Answer\n\n![missing](./assets/nope.png)\n");
    await expect(page.locator('[data-readora-image-state="missing"]')).toBeVisible();
    expect(Date.now() - started).toBeLessThan(5_000);

    // 就地定性的文案要能对上错误码，否则「拒答」对用户就只是「图片不见了」。
    await expect(page.locator(".readora-image-hint").first()).toContainText("超出允许范围");
    expect(await pageErrors(page)).toEqual([]);
  });
});
