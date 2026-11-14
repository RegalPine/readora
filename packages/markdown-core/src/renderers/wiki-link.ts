/**
 * Wiki Link 渲染器（IMP-001 §12.2，STORY-06-03）。
 *
 * 输出形态固定为
 * `<a class="readora-link readora-link--wikilink" tabindex="0" data-readora-wikilink="目标">别名</a>`。
 *
 * **没有 href 是刻意的**（§12.2「Webview 不拼本地路径」）：任何 href 形态都要先把
 * `[[Note]]` 变成 `file:///…/Note.md` 或 `vscode-webview://…/Note`，而那一步需要知道
 * 目标文档的真实位置与是否存在 —— 两者都只有 Host 掌握。留一个猜测的 href，
 * 结果要么是浏览器导航到不存在的地址，要么是一条被 CSP 拦掉后静默失败的链接。
 * 定位信息只有一个作者：`data-readora-wikilink`，点击与回车都由事件委托交
 * `document.navigate`（Webview 侧 interactions.ts）。
 *
 * `tabindex="0"` 补的是没有 href 的代价：无 href 的 `<a>` 不可聚焦，键盘用户会
 * 完全没有入口。加了它就得同时接 Enter / Space，否则焦点停了、键按下无反应 ——
 * 那比不给焦点更糟，两条一起在 interactions.ts 里实现并有用例锁定。
 */
import { escapeHtml } from "../escape";
import { WIKI_LINK_ATTRIBUTE } from "../wiki-link";
import type { MarkdownRenderer } from "../types";
import { attr, fragment } from "./support";

export const WIKI_LINK_CLASS = "readora-link--wikilink";

function labelOf(node: { attributes?: Record<string, unknown>; value?: string }): string {
  const label = node.attributes?.label;
  if (typeof label === "string" && label.length > 0) {
    return label;
  }
  const target = node.attributes?.target;
  if (typeof target === "string" && target.length > 0) {
    return target;
  }
  // 两者皆空的节点不该从处理器出来（判定不成立时它仍是 text），留一条兜底不丢字。
  return node.value ?? "";
}

export const wikiLinkRenderer: MarkdownRenderer = {
  id: "readora.renderer.wikiLink",
  supports: (node) => node.type === "wikiLink",
  render(node) {
    const target = typeof node.attributes?.target === "string" ? node.attributes.target : "";
    return fragment(
      `<a class="readora-link ${WIKI_LINK_CLASS}" tabindex="0" ${WIKI_LINK_ATTRIBUTE}="${attr(
        escapeHtml(target)
      )}">${escapeHtml(labelOf(node))}</a>`
    );
  }
};
