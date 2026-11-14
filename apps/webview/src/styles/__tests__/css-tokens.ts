/**
 * 样式文本的读取与解析（PRD-003 §13.4）。
 *
 * Token 取值的权威是 CSS 文本本身：`design-tokens.spec.ts`（结构）、
 * `contrast.spec.ts`（色值）、`tailwind.spec.ts`（映射）都要从 `src/styles/*.css`
 * 里读声明。各写一份解析器迟早会得出两套答案，所以集中在这里。
 * 解析粒度只到「选择器 + 自定义属性」——门禁需要的就这么多，不做一个 CSS 引擎。
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/** 一个 CSS 块：选择器头 + 花括号内的自定义属性声明。 */
export interface CssBlock {
  selector: string;
  declarations: Map<string, string>;
}

// vitest 以 apps/webview 为 cwd 运行（与 images-fixture.spec.ts 同一口径）。
const STYLE_DIR = resolve(process.cwd(), "src/styles");

/** 按文件名排序的样式文件清单，避免拼接顺序随目录读取顺序漂移。 */
export function styleFiles(): Array<readonly [string, string]> {
  return readdirSync(STYLE_DIR)
    .filter((name) => name.endsWith(".css"))
    .sort()
    .map((name) => [name, readFileSync(resolve(STYLE_DIR, name), "utf8")] as const);
}

export function styleFile(name: string, files = styleFiles()): readonly [string, string] {
  const found = files.find(([file]) => file === name);
  if (!found) {
    throw new Error(`${name} 不在样式目录里`);
  }
  return found;
}

/** 拼接全文：声明与引用跨文件成立即可，不要求同一文件内先声明后使用。 */
export function allCss(files = styleFiles()): string {
  return files.map(([, text]) => text).join("\n");
}

/** 剥掉注释：示例文本与说明里的色值不该混进断言。 */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, "");
}

/**
 * 剥掉 `@media` / `@supports` 分组。
 *
 * 无障碍回退块里的值是另一套真相（forced-colors 下边界是 `CanvasText`），
 * 混进主结构断言会让「:root 里全是系统关键字」这种假象通过。
 */
export function topLevel(text: string): string {
  let body = text;
  for (;;) {
    const start = /@(?:media|supports)[^{]*\{/u.exec(body);
    if (!start) {
      return body;
    }
    let depth = 0;
    let index = start.index + start[0].length - 1;
    for (; index < body.length; index += 1) {
      if (body[index] === "{") {
        depth += 1;
      } else if (body[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    body = `${body.slice(0, start.index)}${body.slice(index + 1)}`;
  }
}

export function blocks(text: string): CssBlock[] {
  const found: CssBlock[] = [];
  const body = stripComments(text);
  const pattern = /([^{}]+)\{([^{}]*)\}/gu;
  let match = pattern.exec(body);
  while (match) {
    const [, rawSelector = "", rawBody = ""] = match;
    const declarations = new Map<string, string>();
    for (const line of rawBody.split("\n")) {
      const entry = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*;?\s*$/u.exec(line);
      if (entry) {
        const [, name = "", value = ""] = entry;
        declarations.set(name, value);
      }
    }
    found.push({ selector: rawSelector.trim(), declarations });
    match = pattern.exec(body);
  }
  return found;
}

/**
 * 取某个选择器下的全部声明；同名块合并（tokens.css 的 `:root` 按层分块书写）。
 *
 * 后者覆盖前者，与级联一致。
 */
export function declarationsFor(selector: string, css = topLevel(allCss())): Map<string, string> {
  const merged = new Map<string, string>();
  for (const block of blocks(css)) {
    if (block.selector === selector) {
      for (const [name, value] of block.declarations) {
        merged.set(name, value);
      }
    }
  }
  return merged;
}

/**
 * `@media` 分组里某个选择器的声明块文本。
 *
 * 必须按「查询 + 块内选择器」两级定位：业务样式里也有同名的回退块
 * （如 lightbox 的去透明规则），只按查询文本找会找错地方。
 */
export function regionOf(cssText: string, query: string, inner: string): string {
  const body = stripComments(cssText);
  const from = body.indexOf(query);
  if (from < 0) {
    throw new Error(`${query} 缺失`);
  }
  const start = body.indexOf(inner, from);
  if (start < from) {
    throw new Error(`${query} 里没有 ${inner}`);
  }
  return body.slice(start, body.indexOf("}", start) + 1);
}

const VAR_RE = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+)\s*)?\)$/u;

/**
 * 沿 `var()` 链取到字面值，等价于浏览器在缺少宿主变量时的解析结果。
 *
 * 找不到目标变量时用它的 fallback 继续（`--vscode-*` 在 CSS 文本里必然「缺失」，
 * 而 fallback 正是无宿主环境下的实际取值）。链过深视为写错，直接抛错而不是回落，
 * 回落会让断言看起来通过。
 */
export function resolveLiteral(name: string, scopes: Map<string, string>[]): string {
  return resolveChain(name, scopes, 0);
}

function lookup(name: string, scopes: Map<string, string>[]): string | undefined {
  for (const scope of scopes) {
    const value = scope.get(name);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function resolveChain(name: string, scopes: Map<string, string>[], depth: number): string {
  if (depth > 8) {
    throw new Error(`${name} 的 var() 链过深`);
  }
  const value = lookup(name, scopes);
  if (value === undefined) {
    throw new Error(`${name} 未声明`);
  }
  const match = VAR_RE.exec(value);
  if (!match) {
    return value;
  }
  const target = match[1] ?? "";
  const fallback = match[2];
  if (lookup(target, scopes) !== undefined) {
    return resolveChain(target, scopes, depth + 1);
  }
  if (fallback === undefined) {
    throw new Error(`${target} 未声明且没有 fallback`);
  }
  const nested = VAR_RE.exec(fallback);
  if (!nested) {
    return fallback;
  }
  const nestedTarget = nested[1] ?? "";
  if (lookup(nestedTarget, scopes) !== undefined) {
    return resolveChain(nestedTarget, scopes, depth + 1);
  }
  const nestedFallback = nested[2];
  if (nestedFallback === undefined) {
    throw new Error(`${nestedTarget} 未声明且没有 fallback`);
  }
  return nestedFallback;
}
