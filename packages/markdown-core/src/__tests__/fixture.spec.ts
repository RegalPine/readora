/**
 * Fixture 回归（计划 §手工/产物验收）：tests/fixtures/sample.md 覆盖 M2 全部语法面，
 * 这里把它跑进真实管线，作为「真机冒烟之前唯一的自动化证据」。
 *
 * 该 spec 只在测试进程读盘（node:fs），不影响 markdown-core 运行时的零 Node 依赖约束。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../index";
import { MATH_MARKUP_SCOPE } from "../sanitizer";
import type { MarkdownRenderResult } from "../types";

const FIXTURE_PATH = resolve(process.cwd(), "../../tests/fixtures/sample.md");
const SOURCE = readFileSync(FIXTURE_PATH, "utf8");

const RESULT: MarkdownRenderResult = renderMarkdown({
  documentId: "file:///fixture/sample.md",
  documentUri: "file:///fixture/sample.md",
  version: 1,
  text: SOURCE
});

function dom(html: string): Document {
  return new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
}

function body(html: string): HTMLElement {
  return dom(html).body.firstElementChild as HTMLElement;
}

const root = body(RESULT.html);

describe("fixture 覆盖度自检", () => {
  it("样例文件足够大，且包含本期全部语法标记", () => {
    expect(SOURCE.length).toBeGreaterThan(2000);
    for (const marker of [
      "```mermaid",
      "- [x]",
      "| :----- |",
      "## 重复标题",
      "<script>",
      "![",
      "[相对链接（本期降级）](./other-note.md)",
      "#中文标题锚点测试"
    ]) {
      expect(SOURCE, marker).toContain(marker);
    }
  });
});

describe("fixture 渲染结果", () => {
  it("整篇不失败：没有 error 级诊断", () => {
    expect(RESULT.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(RESULT.html).not.toContain("readora-plain");
  });

  it("frontmatter 提取为 metadata，且不残留在正文", () => {
    expect(RESULT.metadata.title).toBe("Readora M2 渲染样例");
    expect(RESULT.metadata.description).toContain("验收样例");
    expect(RESULT.metadata.tags).toEqual(["markdown", "rendering", "security"]);
    expect(RESULT.html).not.toContain("---");
  });

  it("六级标题全部渲染，CJK 与重复标题锚点正确", () => {
    const headings = Array.from(root.querySelectorAll("h1, h2, h3, h4, h5, h6"));
    // DOM 标题序列必须与 outline 逐项一致（层级与顺序是锚点跳转的前提，RND-AC-008）
    expect(headings.length).toBe(RESULT.outline.length);
    expect(headings.map((element) => Number.parseInt(element.tagName.slice(1), 10))).toEqual(
      RESULT.outline.map((item) => item.level)
    );
    expect(headings.map((element) => element.tagName)).toContain("H6");

    const anchors = RESULT.outline.map((item) => item.anchor);
    expect(anchors).toContain("中文标题锚点测试");
    expect(anchors.filter((anchor) => anchor.startsWith("重复标题"))).toEqual([
      "重复标题",
      "重复标题-1",
      "重复标题-2"
    ]);
    expect(new Set(anchors).size).toBe(anchors.length);
    expect(RESULT.outline.map((item) => item.level)).toContain(6);
    // 锚点必须可定位：镜像属性对每个 outline anchor 都存在
    for (const anchor of anchors) {
      expect(root.querySelector(`[data-readora-heading="${anchor}"]`), anchor).not.toBeNull();
    }
    // id 形式对绝大多数 anchor 也成立，只有与 document 具名属性冲突的会被剥离
    const withId = anchors.filter((anchor) => root.querySelector(`[id="${anchor}"]`) !== null);
    expect(withId.length).toBe(anchors.length - 1);
    // 本例命中的冲突项：document.images 是具名集合，id 被剥离、镜像仍在
    const imagesHeading = root.querySelector('[data-readora-heading="images"]');
    expect(imagesHeading?.getAttribute("id") ?? "").toBe("");
  });

  it("列表、任务列表、有序列表起始序号与嵌套引用成形", () => {
    expect(root.querySelector('ol[start="10"]')).not.toBeNull();
    expect(root.querySelectorAll(".readora-task-marker").length).toBeGreaterThanOrEqual(3);
    expect(root.querySelectorAll("blockquote blockquote blockquote").length).toBe(1);
    expect(root.querySelectorAll("ol ul ul, ul ul ul").length).toBeGreaterThanOrEqual(1);
  });

  it("表格保留对齐与表头 scope，并包在滚动容器内", () => {
    const table = root.querySelector(".readora-table-scroll table");
    expect(table).not.toBeNull();
    expect(root.querySelectorAll("th").length).toBe(9);
    expect(root.querySelector('th[data-align="center"]')).not.toBeNull();
    expect(root.querySelector('th[scope="col"]')).not.toBeNull();
  });

  it("代码块高亮、语言标识与复制按钮齐备，未知语言只降级", () => {
    const blocks = Array.from(root.querySelectorAll(".readora-code-block"));
    expect(blocks.map((block) => block.getAttribute("data-readora-code-lang"))).toEqual([
      "ts",
      "python",
      "text",
      "not-a-real-language"
    ]);
    expect(blocks.map((block) => block.getAttribute("data-readora-code-state"))).toEqual([
      "highlighted",
      "highlighted",
      "plain",
      "unsupported"
    ]);
    const ts = blocks[0];
    expect(ts?.querySelector("code [class^='hljs-']")).not.toBeNull();
    expect(ts?.querySelector("code")?.textContent).toContain("export function greet");
    expect(root.querySelectorAll("button[data-readora-copy]").length).toBe(4);
    expect(
      RESULT.diagnostics.some(
        (item) => item.code === "readora.render.unsupported-language" && item.severity === "warning"
      )
    ).toBe(true);
  });

  it("mermaid 只识别不渲染，源码原样保留并给出 info 诊断", () => {
    const diagram = root.querySelector(".readora-diagram");
    expect(diagram).not.toBeNull();
    expect(diagram?.textContent).toContain("graph TD");
    expect(diagram?.querySelector("svg")).toBeNull();
    expect(
      RESULT.diagnostics.some((item) => item.code === "readora.render.diagram-deferred")
    ).toBe(true);
  });

  it("链接分类：外链交给 Host 打开、锚点本地滚动、相对链接惰性降级", () => {
    const externals = Array.from(root.querySelectorAll("a[data-readora-external]"));
    expect(externals.length).toBeGreaterThanOrEqual(2);
    for (const link of externals) {
      expect(link.getAttribute("href")).toBe(link.getAttribute("data-readora-external"));
      expect(link.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    }
    expect(root.querySelector('a[data-readora-anchor="lists"]')).not.toBeNull();
    // CJK 锚点在 markdown-it 侧就被百分号编码，渲染层原样保留（解码发生在应用层）
    const encoded = root.querySelector(
      'a[data-readora-anchor="%E4%B8%AD%E6%96%87%E6%A0%87%E9%A2%98%E9%94%9A%E7%82%B9%E6%B5%8B%E8%AF%95"]'
    );
    expect(encoded).not.toBeNull();
    expect(encoded?.getAttribute("href")).toBe(
      "#%E4%B8%AD%E6%96%87%E6%A0%87%E9%A2%98%E9%94%9A%E7%82%B9%E6%B5%8B%E8%AF%95"
    );
    const inert = root.querySelector('[data-readora-relative="./other-note.md"]');
    expect(inert).not.toBeNull();
    expect(inert?.getAttribute("aria-disabled")).toBe("true");
    expect(inert?.getAttribute("href") ?? "").toBe("");
  });

  it("图片产出无 src 的 <img> 语义结构，原地址只作 data 标记", () => {
    const images = Array.from(root.querySelectorAll("img"));
    expect(images.length).toBe(3);
    for (const image of images) {
      expect(image.getAttribute("src")).toBeNull();
      expect(image.closest(".readora-image")?.getAttribute("data-readora-image-state")).toBe(
        "pending"
      );
    }
    expect(root.querySelector('[data-readora-image="https://example.com/assets/logo.png"]')).not.toBeNull();
    expect(
      RESULT.diagnostics.filter((item) => item.code === "readora.render.image-deferred").length
    ).toBe(3);
  });

  it("mailto / file / data 协议在渲染层降级为纯文本（ARC-008 §8.3）", () => {
    const hrefs = Array.from(root.querySelectorAll("a")).map((anchor) =>
      (anchor.getAttribute("href") ?? "").toLowerCase()
    );
    expect(hrefs.some((href) => href.startsWith("mailto:"))).toBe(false);
    expect(hrefs.some((href) => href.startsWith("data:"))).toBe(false);
    expect(hrefs.some((href) => href.startsWith("file:"))).toBe(false);
    expect(hrefs.every((href) => href === "" || /^(#|https?:)/.test(href))).toBe(true);
    expect(
      RESULT.diagnostics.some((item) => item.code === "readora.render.link-scheme-blocked")
    ).toBe(true);
  });

  it("原始 HTML 片段一律转义为可见文本，DOM 内无可执行结构", () => {
    const text = root.textContent ?? "";
    expect(text).toContain("<div onclick=\"alert('xss')\">原始 HTML 块</div>");
    expect(text).toContain("<script>alert('script 标签必须消失')</script>");
    // 公式白名单是限域的（IMP-001 §10.3）：KaTeX 的 svg 只能出现在 .readora-math 子树里，
    // 文档自带的 <svg onload> 必须已被 restrictMathMarkup 整节点删掉。
    const outsideMath = (selector: string): Element[] =>
      Array.from(root.querySelectorAll(selector)).filter(
        (element) => element.closest(`.${MATH_MARKUP_SCOPE}`) === null
      );
    expect(outsideMath("script, iframe, object, embed, style, form, svg")).toHaveLength(0);
    expect(root.querySelectorAll("[src]")).toHaveLength(0);

    for (const element of Array.from(root.querySelectorAll("*"))) {
      const inMathScope = element.closest(`.${MATH_MARKUP_SCOPE}`) !== null;
      for (const name of element.getAttributeNames()) {
        expect(/^on[a-z]+$/i.test(name), `${element.tagName}/${name}`).toBe(false);
        // 「扩了公式白名单」不等于「扩了可达面」：子树外的 style 一律不可得。
        if (!inMathScope) {
          expect(name.toLowerCase(), "style attribute outside math scope").not.toBe("style");
        }
      }
    }
    // 被限域剥掉的是属性而非文本，「红色文字」四个字必须还在（KEEP_CONTENT）。
    expect(text).toContain("红色文字");
  });

  it("分隔线与数学公式按 M6 口径呈现", () => {
    expect(root.querySelectorAll("hr").length).toBeGreaterThanOrEqual(1);

    const inline = Array.from(root.querySelectorAll(".readora-math--inline"));
    const block = Array.from(root.querySelectorAll(".readora-math--block"));
    expect(inline.length).toBeGreaterThanOrEqual(1);
    expect(block.length).toBeGreaterThanOrEqual(1);
    // 公式内容进入 KaTeX 结构，定界符本身不再以裸文本出现
    expect(root.querySelector(".katex")).not.toBeNull();
    expect(root.textContent).not.toContain("$E=mc^2$");

    const degraded = Array.from(root.querySelectorAll<HTMLElement>("[data-readora-math-status='error']"));
    expect(degraded).toHaveLength(1);
    // §10.2 第 2 条：单条失败只降级本条，源码可见，同段落其余内容照常
    expect(degraded[0]?.textContent).toBe("\\frac{1}{");
    expect(degraded[0]?.parentElement?.textContent).toContain("之后的一句话仍然可读");
    expect(
      RESULT.diagnostics.some(
        (item) => item.code === "readora.render.math-failed" && item.severity === "warning"
      )
    ).toBe(true);

    // 货币写法从未成为公式（§10.1 三条拒判）
    expect(root.textContent).toContain("总价 $100 和 $200 都还是普通文本。");
    // output: "html" 不产 MathML，于是不会有被白名单剥空的壳
    expect(root.querySelectorAll(".katex-mathml").length).toBe(0);
  });
});
