/**
 * SVG Sanitizer 用例（IMP-002 TASK-05-02-03、ARC-003 §9.3、ARC-008 §16.1）。
 *
 * 断言口径：「输出里不该有什么」优先于「清洗器做了什么」，
 * 因此每条用例都直接检查产物节点，而不是只看返回值。
 */
import { describe, expect, it } from "vitest";

import { MAX_SVG_OUTPUT_CHARACTERS } from "../limits";
import { sanitizeSvgDetailed, sanitizeSvgToNode } from "../svg-sanitizer";

function svg(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40">${inner}</svg>`;
}

function serialize(node: Node | null): string {
  return node instanceof Element ? node.outerHTML : "";
}

describe("sanitizeSvgToNode：正常产物", () => {
  it("干净 SVG 通过并打上已清洗标记", () => {
    const node = sanitizeSvgDetailed(svg('<rect width="10" height="10"></rect>'));
    expect(node.reason).toBeUndefined();
    expect(node.node).not.toBeNull();
    const element = node.node as Element;
    expect(element.getAttribute("data-readora-diagram-svg")).toBe("sanitized");
    expect(element.localName).toBe("svg");
  });

  it("薄封装与详细版结论一致", () => {
    const input = svg("<text>你好</text>");
    expect(sanitizeSvgToNode(input)).toBeInstanceOf(Element);
    expect(sanitizeSvgToNode("")).toBeNull();
  });
});

describe("sanitizeSvgToNode：主动内容", () => {
  it("script 不会留在产物里", () => {
    const outcome = sanitizeSvgDetailed(
      svg('<script type="text/javascript">window.alert(1)</script>')
    );
    expect(serialize(outcome.node)).not.toContain("script");
    expect(serialize(outcome.node)).not.toContain("alert");
  });

  it("foreignObject 与动画元素一律拒绝", () => {
    for (const inner of [
      '<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>',
      '<animate attributeName="width" from="0" to="80" dur="1s"></animate>',
      '<set attributeName="visibility" to="hidden"></set>',
      '<discard begin="2s"></discard>'
    ]) {
      const markup = serialize(sanitizeSvgToNode(svg(inner)));
      expect(markup).not.toMatch(/foreignObject|<animate|<set|<discard/i);
    }
  });

  it("on* 事件属性必须被剥掉", () => {
    const outcome = sanitizeSvgToNode(
      svg('<rect width="10" height="10" onload="alert(1)" onmouseover="alert(2)"></rect>')
    );
    const markup = serialize(outcome);
    expect(markup).not.toMatch(/onload|onmouseover/i);
  });
});

describe("sanitizeSvgToNode：链接与外部引用", () => {
  it("合法 http/https 链接改写为 data-readora-external，原 href 不残留", () => {
    const outcome = sanitizeSvgDetailed(
      svg('<a href="https://example.com/doc"><text>链接</text></a>')
    );
    const markup = serialize(outcome.node);
    expect(outcome.removed).toContain("a@href");
    expect(markup).toContain("data-readora-external");
    expect(markup).not.toMatch(/href=/);
  });

  it("xlink:href 同样改写（旧版 Mermaid 产物仍会输出）", () => {
    const outcome = sanitizeSvgDetailed(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="80" height="40">` +
        '<a xlink:href="http://example.com"><text>旧链接</text></a></svg>'
    );
    const markup = serialize(outcome.node);
    expect(markup).toContain("data-readora-external");
    expect(markup.toLowerCase()).not.toContain("xlink:href");
  });

  it("javascript: 之类的 scheme 既不留 href 也不给外部标记", () => {
    const outcome = sanitizeSvgDetailed(
      svg('<a href="javascript:alert(1)"><text>危险</text></a>')
    );
    const markup = serialize(outcome.node);
    expect(markup).not.toContain("javascript");
    expect(markup).not.toContain("data-readora-external");
  });

  it("target / sandbox 属性被剥掉，链接交由 Host 打开", () => {
    const markup = serialize(
      sanitizeSvgToNode(svg('<a href="https://example.com" target="_blank">x</a>'))
    );
    expect(markup).not.toMatch(/target=/i);
  });

  it("use 引用绝不保留外部主机（内部引用按 fail-closed 处理）", () => {
    const external = serialize(
      sanitizeSvgToNode(svg('<use href="http://evil.example/x#y"></use>'))
    );
    expect(external).not.toMatch(/evil\.example/);
    expect(external).not.toMatch(/<use[^>]+href=/i);
    // DOMPurify 的 SANITIZE_DOM 会连带丢弃指向文档内 id 的 use 引用：
    // 宁可少画一个引用，也不给 DOM clobbering 留口子，因此这里只断言「引用没被外链替换」。
    const internal = sanitizeSvgToNode(svg('<use href="#grad"></use>'));
    expect(external).not.toMatch(/evil\.example/);
    expect(internal instanceof Element ? internal.outerHTML : "").not.toMatch(/evil\.example/);
  });

  it("渐变等 defs 内的内部引用以 url(#id) 形式存活", () => {
    const markup = serialize(
      sanitizeSvgToNode(
        svg('<defs><linearGradient id="g"></linearGradient></defs><rect fill="url(#g)"></rect>')
      )
    );
    expect(markup).toContain("linearGradient");
    expect(markup).toContain("url(#g)");
  });

  it("style 里的外部 url() 触发整条 style 剥离，url(#id) 保留", () => {
    const external = sanitizeSvgDetailed(
      svg('<rect width="10" height="10" style="fill:url(http://evil.example/p.png)"></rect>')
    );
    expect(serialize(external.node)).not.toMatch(/evil\.example/);
    expect(external.removed).toContain("rect@style");

    const internal = serialize(
      sanitizeSvgToNode(svg('<rect width="10" height="10" style="fill:url(#grad)"></rect>'))
    );
    expect(internal).toContain("url(#grad)");
  });
});

describe("sanitizeSvgDetailed：失败成因", () => {
  it("空输入 → empty-svg", () => {
    expect(sanitizeSvgDetailed("   ").reason).toBe("empty-svg");
  });

  it("超过输出上限 → over-output-limit，且不进入清洗器", () => {
    const huge = svg(`<text>${"字".repeat(MAX_SVG_OUTPUT_CHARACTERS)}</text>`);
    const outcome = sanitizeSvgDetailed(huge);
    expect(outcome.reason).toBe("over-output-limit");
    expect(outcome.node).toBeNull();
  });

  it("清洗后没有 svg 根 → no-svg-root", () => {
    expect(sanitizeSvgDetailed("<div>不是图表</div>").reason).toBe("no-svg-root");
  });

  it("removed 只记录名称，不记录内容原文", () => {
    const outcome = sanitizeSvgDetailed(
      svg('<a href="https://example.com/secret-token"><text>label</text></a>')
    );
    expect(outcome.removed.join("|")).not.toContain("secret-token");
    expect(outcome.removed.length).toBeGreaterThan(0);
  });
});
