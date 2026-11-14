/**
 * 硬编码色禁令（PRD-003 §13.4 / §13.2，IMP-003 §4.6 第 5 项）。
 *
 * M5 之前 global.css 里有 113 处 `#hex`，主题切换只能靠重写整条规则来跟着变，
 * 暗色也就永远补不齐。现在色值只允许活在 tokens.css 的 Primitive 层里：
 * 其他任何样式文件出现字面色值，就说明有人在绕过 Token。
 *
 * 断言先剥注释：说明文字里的示例色不算违规，但也必须数得过来（见最后一条）。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments, styleFiles } from "./css-tokens";

/** 字面色值：十六进制与函数式写法。`rgb(` 与 `rgba(`、`hsl(` 与 `hsla(` 一并覆盖。 */
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/gu;

/** tokens.css 里唯一允许出现字面色值的两类声明。 */
const LITERAL_ALLOWED = /^--readora-(?:palette|shadow)-/u;

/** 业务样式：token 的消费方，一个色值都不许写。 */
const BUSINESS = ["base.css", "markdown.css", "components.css", "shell.css", "lightbox-search.css"];

/** utility 层与字体层：只映射变量、只引字体，同样不写色。 */
const NON_COLOR = ["tailwind.css", "fonts.css"];

/** 找出带字面色值的声明，报错时直接指出违规的那条。 */
function offendingDeclarations(text: string): string[] {
  const found: string[] = [];
  for (const match of stripComments(text).matchAll(/(--[\w-]+|[a-z-]+)\s*:\s*([^;{}]*)/gu)) {
    const [, name = "", value = ""] = match;
    if (COLOR_LITERAL.test(value)) {
      found.push(`${name}: ${value.trim()}`);
    }
    COLOR_LITERAL.lastIndex = 0;
  }
  return found;
}

describe("业务样式不得出现硬编码色", () => {
  const files = styleFiles();
  for (const name of [...BUSINESS, ...NON_COLOR]) {
    const entry = files.find(([file]) => file === name);
    if (!entry) {
      throw new Error(`${name} 不在样式目录里`);
    }
    it(`${name}`, () => {
      const offenders = offendingDeclarations(entry[1]);
      expect(offenders, `写死了色值：\n${offenders.join("\n")}`).toStrictEqual([]);
      // 声明之外也不该有色值（选择器、属性名以外的任何位置）。
      COLOR_LITERAL.lastIndex = 0;
      expect(stripComments(entry[1])).not.toMatch(COLOR_LITERAL);
    });
  }
});

describe("tokens.css 的字面色值只活在 Primitive 与阴影里", () => {
  const text = styleFiles().find(([name]) => name === "tokens.css")?.[1];
  if (text === undefined) {
    throw new Error("tokens.css 不在样式目录里");
  }
  const body = stripComments(text);

  it("每条带色值的自定义属性都以 --readora-palette- 或 --readora-shadow- 开头", () => {
    const offenders: string[] = [];
    for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;{}]*)/gu)) {
      const [, name = "", value = ""] = match;
      COLOR_LITERAL.lastIndex = 0;
      if (COLOR_LITERAL.test(value) && !LITERAL_ALLOWED.test(name)) {
        offenders.push(`${name}: ${value.trim()}`);
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it("色值不会出现在声明之外（选择器、混入、注释残留）", () => {
    const outside = body
      .split("\n")
      .filter((line) => !/^\s*(--[\w-]+|[a-z-]+)\s*:/u.test(line) && /#[0-9a-fA-F]{3,8}\b|\brgba?\(/u.test(line));
    expect(outside).toStrictEqual([]);
  });
});

describe("主题选择器只在 Token 层", () => {
  it("业务样式不再写 [data-readora-theme=...] / [data-readora-scheme=...]", () => {
    // 切换主题靠改 `<html>` 上的属性生效；业务样式自己按属性写色，等于又开了第二条上色路径。
    const files = styleFiles();
    const offenders = BUSINESS.filter((name) => {
      const entry = files.find(([file]) => file === name);
      return entry !== undefined && /\[data-readora-(?:theme|scheme)/u.test(stripComments(entry[1]));
    });
    expect(offenders).toStrictEqual([]);
  });
});

describe("dev 夹具样式同样只许用 Token", () => {
  // 它不在 src/styles 里（不进产物），但它是仓库里唯一的第四方样式文件：
  // 基线页写死一个色，量的就不是生产形态了。见 apps/webview/dev/visual.css。
  it("dev/visual.css 没有硬编码色", () => {
    const text = readFileSync(resolve(process.cwd(), "dev/visual.css"), "utf8");
    const offenders = offendingDeclarations(text);
    expect(offenders, `写死了色值：\n${offenders.join("\n")}`).toStrictEqual([]);
  });
});
