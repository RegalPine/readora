/**
 * 自定义 CSS 的净化门禁（PRD-001 F08-011，IMP-003 §7.2 安全准入第 4 条）。
 *
 * `readora.customCss` 是不可信输入：工作区可以自带 `.vscode/settings.json`，
 * 打开别人的仓库就等于执行别人写的样式。ARC-006 通篇没有这套规则（0 命中），
 * 本批在代码里定案并登记偏差，因此这里逐条断言的是**规则本身**，不是实现细节。
 *
 * 三条结构性口径（`custom-css.ts` 头注释）各配一组用例：
 * 注入的是 AST 重生成文本、任一违规整段拒绝、选择器必须落在阅读器作用域内。
 */
import { describe, expect, test } from "vitest";
import {
  ALLOWED_AT_RULE_NAMES,
  DEFAULT_CUSTOM_CSS_MAX_CHARS,
  FORBIDDEN_CUSTOM_CSS_PROPERTIES,
  sanitizeCustomCss
} from "../custom-css";

/** `[源码, 拒绝理由里必须出现的片段]`：理由要进用户可见的诊断日志，所以一并断言。 */
const REJECTED: Array<readonly [string, string]> = [
  // 1. 外部资源引用：`@import` 能拉来任意远端样式，等于给 CSP 开个洞。
  ["@import url('https://evil.example/x.css');", '@import" is not allowed'],
  // 2. IE 的「CSS 里执行表达式」。
  [".readora-prose { width: expression(document.body.clientWidth * 2) }", "blocked construct"],
  // 3. 反斜杠混淆：`\2e ` 就是 `.`，绕过了字面量匹配，一律先拒。
  ["\\2e readora-prose { color: red }", "backslash escapes"],
  [".readora\\2d prose { color: red }", "backslash escapes"],
  // 4. 越权选择器：宿主 UI、全局元素、ID、自定义属性都不属于阅读版面微调。
  ["body { margin: 0 }", "must start with .readora-"],
  ["html { scroll-behavior: smooth }", "must start with .readora-"],
  ["* { color: red }", "must start with .readora-"],
  [":root { --readora-font-size: 40px }", "must start with .readora-"],
  ["#readora-prose { color: red }", "must start with .readora-"],
  // 逗号列表里只要有一条越权，整段就不成立（见下面「整段拒绝」那条用例）。
  [".readora-prose { color: red } body { color: blue }", "must start with .readora-"],
  // 5. 行为类属性与旧绑定：属性名黑名单逐条覆盖。
  [".readora-prose { behavior: url(#default#userData) }", 'property "behavior"'],
  [".readora-prose { -moz-binding: url(https://evil/x.xml#y) }", 'property "-moz-binding"'],
  // 6. 值里的危险构造：`progid:` 滤镜与 `javascript:` 协议。
  [".readora-prose { filter: progid:DXImageTransform.Microsoft.gradient() }", "blocked construct"],
  [".readora-prose { background: javascript:alert(1) }", "blocked construct"],
  // 7. 远程资源：只有 `data:image/…;base64` 这一种形态可以接受。
  [".readora-prose { background: url(https://evil.example/a.png) }", "base64 data:image"],
  ['.readora-prose { background: url("https://evil.example/a.png") }', "base64 data:image"],
  [".readora-prose { list-style-image: url(//evil.example/a.png) }", "base64 data:image"],
  // 8. 非白名单 at-rule。
  ["@keyframes spin { from { transform: rotate(0) } }", '@keyframes" is not allowed'],
  ["@font-face { font-family: evil; src: url(https://evil/x.woff2) }", '@font-face" is not allowed'],
  ["@media (max-width: 600px) { body { color: red } }", "must start with .readora-"],
  // 9. 控制字符只可能用来藏住别的东西（`\0`、NUL、退格）。
  [".readora-prose { color: red }\u0000", "control characters"],
  // 10. 空条目（`, .readora-x`）意味着选择器被截断过，语义不可猜。
  [".readora-a, { color: red }", "empty entry"]
];

describe("整段拒绝的不可信写法", () => {
  for (const [source, fragment] of REJECTED) {
    test(`${source.slice(0, 46)} —— ${fragment}`, () => {
      const outcome = sanitizeCustomCss(source);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.reason).toContain(fragment);
      }
    });
  }

  test("任一违规整段拒绝：坏规则旁边的良规则也不会被单独采纳", () => {
    const outcome = sanitizeCustomCss(
      [
        ".readora-prose { line-height: 2 }",
        "@import url('https://evil.example/x.css');",
        ".readora-toolbar { height: 60px }"
      ].join("\n")
    );
    // 半采纳会让用户以为自己的 CSS 生效了、实际只生效一半，是最难排查的那类错误。
    // 判别联合的类型就在这里起作用：`ok: false` 那一支根本没有 `css` 字段可拿。
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("必须整段拒绝");
    }
  });

  test("长度超限是拒绝，不是截断", () => {
    // `/*` + 填充 + `*/` 恰好凑到上限：边界内整段通过，多一个字符整段拒绝。
    const atLimit = `/*${"x".repeat(DEFAULT_CUSTOM_CSS_MAX_CHARS - 4)}*/`;
    expect(atLimit.length).toBe(DEFAULT_CUSTOM_CSS_MAX_CHARS);
    expect(sanitizeCustomCss(atLimit).ok).toBe(true);
    const outcome = sanitizeCustomCss(`${atLimit}x`);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toContain(`above the ${DEFAULT_CUSTOM_CSS_MAX_CHARS} limit`);
    }
  });

  test("策略可下调长度上限（manifest 与 Host 共用同一个权威）", () => {
    expect(sanitizeCustomCss(".readora-a{color:red}", { maxChars: 8 }).ok).toBe(false);
    expect(sanitizeCustomCss(".readora-a{color:red}", { maxChars: 512 }).ok).toBe(true);
  });

  test("`</style>` 收尾写法即便被解析器接受，也过不了注入前的最后一道判断", () => {
    // css-tree 容错，会把尾部垃圾丢掉或原样带进 AST；两种出口都不允许有 `<`。
    const outcome = sanitizeCustomCss(".readora-a{color:red}</style><script>alert(1)</script>");
    expect(outcome.ok ? outcome.css : "").not.toContain("<");
  });
});

describe("允许的微调写法", () => {
  const ACCEPTED: Array<readonly [string, string]> = [
    [".readora-prose { line-height: 2; }", ".readora-prose{line-height:2}"],
    // 属性选择器：公式状态、预设这类结构开关都在 data-* 上。
    [
      '[data-readora-math-status="error"] { font-family: monospace; }',
      '[data-readora-math-status="error"]{font-family:monospace}'
    ],
    // 后代与并列选择器：只要起点是阅读器自己的作用域就成立。
    [".readora-prose .readora-heading { letter-spacing: 0.02em }", ".readora-prose .readora-heading{letter-spacing:0.02em}"],
    ["@media (max-width: 600px) { .readora-prose { font-size: 15px } }", "@media (max-width:600px){.readora-prose{font-size:15px}}"],
    ["@supports (backdrop-filter: blur(2px)) { .readora-toolbar { backdrop-filter: none } }", "@supports (backdrop-filter:blur(2px)){.readora-toolbar{backdrop-filter:none}}"],
    [".readora-prose { background: url(data:image/png;base64,iVBORw0=) }", ".readora-prose{background:url(data:image/png;base64,iVBORw0=)}"]
  ];

  for (const [source, expected] of ACCEPTED) {
    test(source.slice(0, 48), () => {
      const outcome = sanitizeCustomCss(source);
      expect(outcome.ok, outcome.ok ? "" : outcome.reason).toBe(true);
      if (outcome.ok) {
        expect(outcome.css).toBe(expected);
      }
    });
  }

  test("注入的是重生成文本：注释、原文缩进与多余分号都不带", () => {
    const outcome = sanitizeCustomCss(
      "/* 我的微调 */\n.readora-prose {\n  line-height: 2;\n}\n"
    );
    expect(outcome.ok && outcome.css).toBe(".readora-prose{line-height:2}");
  });

  test("被截断的残句按解析结果补齐，而不是把原文照抄进 <style>", () => {
    // 这条是「注入 AST 产物」换来的好处：过滤与转义不再是两件要同时做对的事。
    const outcome = sanitizeCustomCss(".readora-prose { color: red");
    expect(outcome.ok && outcome.css).toBe(".readora-prose{color:red}");
  });

  test("空输入与全注释输入都归一为空串（调用方据此不产出 <style> 节点）", () => {
    for (const source of ["", "   ", "/* 只有注释 */"]) {
      const outcome = sanitizeCustomCss(source);
      expect(outcome.ok, source).toBe(true);
      if (outcome.ok) {
        expect(outcome.css, source).toBe("");
      }
    }
  });

  test("空规则是合法的 no-op，按原样留下一条空规则（不视作「未设置」）", () => {
    const outcome = sanitizeCustomCss(".readora-a {}");
    expect(outcome.ok && outcome.css).toBe(".readora-a{}");
  });

  test("CRLF 换行不影响判定", () => {
    const outcome = sanitizeCustomCss(".readora-a{color:red}\r\n.readora-b{color:blue}");
    expect(outcome.ok && outcome.css).toBe(".readora-a{color:red}.readora-b{color:blue}");
  });

  test("块外的散分号按越权选择器整段拒绝：宁可误拒也不放行看不懂的构造", () => {
    // 顶层 `;` 不是合法 CSS（浏览器按解析错误忽略）。这里选 fail-closed：与其猜
    // 用户想写什么，不如把 reason 交出去让他改——诊断日志里能看到那条选择器。
    expect(sanitizeCustomCss(".readora-a{color:red};\n.readora-b{color:blue}").ok).toBe(false);
  });
});

describe("规则清单自身的形状", () => {
  test("at-rule 白名单只有 media 与 supports", () => {
    expect(ALLOWED_AT_RULE_NAMES).toStrictEqual(["media", "supports"]);
  });

  test("属性黑名单覆盖四个已知执行入口", () => {
    expect(FORBIDDEN_CUSTOM_CSS_PROPERTIES).toContain("behavior");
    expect(FORBIDDEN_CUSTOM_CSS_PROPERTIES).toContain("-moz-binding");
    expect(FORBIDDEN_CUSTOM_CSS_PROPERTIES).toContain("expression");
  });

  test("通过的产物永远不含 `<`：注入通道的硬前提", () => {
    // 混进清单里的每一条「看起来能过」的写法一起遍历：这条不变量是
    // `html-template.ts` 敢把文本原样放进 `<style>` 的唯一理由。
    const samples = [
      ...REJECTED.map(([source]) => source),
      ".readora-prose { line-height: 2 }",
      ".readora-prose { color: red",
      ".readora-a{}",
      "@media print { .readora-prose { color: black } }",
      "[data-readora-preset=\"high-contrast\"] .readora-prose { text-shadow: none }"
    ];
    for (const source of samples) {
      const outcome = sanitizeCustomCss(source);
      if (outcome.ok) {
        expect(outcome.css, source).not.toContain("<");
      }
    }
  });
});
