/**
 * 文档内搜索测试（ARC-007 §9.1 / §9.2 / §9.4 / §13，STORY-07-03）。
 *
 * 三条不可让的底线在这里逐条钉死：
 * 1. 高亮可逐字符还原（还原后 textContent 与搜索前全等）；
 * 2. 图形化子树不进匹配范围；
 * 3. 结果带文档版本，供失效判定。
 */
import { beforeEach, describe, expect, test } from "vitest";
import { EDIT_CONFLICT_CLASS } from "../edit/edit-unit";
import {
  DOCUMENT_VERSION_ATTRIBUTE,
  MAX_SEARCH_HITS,
  SEARCH_ACTIVE_ATTRIBUTE,
  SEARCH_HIT_CLASS,
  SEARCH_HIT_ID_ATTRIBUTE,
  SEARCH_HIT_VERSION_ATTRIBUTE,
  activateMatch,
  applyHighlights,
  clearHighlights,
  excludedSelector,
  formatMatchCount,
  highlightVersion,
  isTruncated,
  searchInDocument,
  type SearchOutcome
} from "../search-engine";

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.className = "readora-document";
  host.innerHTML = html;
  document.body.replaceChildren(host);
  return host;
}

function run(
  root: HTMLElement,
  query: string,
  caseSensitive = false,
  version = 7
): SearchOutcome {
  return searchInDocument(root, { query, caseSensitive }, version, "file:///doc.md");
}

const PROSE = `
  <h2 id="overview" data-readora-heading="overview">Overview</h2>
  <p>The rendering layer draws the canvas. The engine is pluggable.</p>
  <h2 id="details" data-readora-heading="details">Details</h2>
  <p>Engine options live in <code>renderer.engine</code> and the engine name is free.</p>
`;

beforeEach(() => {
  document.body.replaceChildren();
});

describe("匹配（§9.1 / §9.2）", () => {
  test("默认不区分大小写，命中带 position 与 text", () => {
    const root = mount(PROSE);
    const { result } = run(root, "ENGINE");
    expect(result.matches.length).toBe(4);
    expect(result.matches.map((match) => match.text)).toEqual([
      "engine",
      "Engine",
      "engine",
      "engine"
    ]);
    expect(result.matches[0]?.position).toBe(root.textContent.indexOf("engine"));
    expect(result.documentId).toBe("file:///doc.md");
    expect(result.documentVersion).toBe(7);
    expect(result.activeMatchIndex).toBe(0);
  });

  test("caseSensitive 打开后只匹配同形写法", () => {
    const root = mount(PROSE);
    expect(run(root, "engine", true).result.matches.length).toBe(3);
    expect(run(root, "ENGINE", true).result.matches).toHaveLength(0);
  });

  test("代码块参与匹配，它也是文档文本", () => {
    const root = mount(PROSE);
    expect(run(root, "renderer.engine").result.matches.length).toBe(1);
  });

  test("命中归属到文档顺序上最近的前置标题（§9.2 headingId）", () => {
    const root = mount(PROSE);
    const matches = run(root, "engine").result.matches;
    expect(matches.map((match) => match.headingId)).toEqual([
      "overview",
      "details",
      "details",
      "details"
    ]);
  });

  test("标题自身的文字也算命中，并归到它自己", () => {
    const root = mount(PROSE);
    const [first] = run(root, "Details").result.matches;
    expect(first?.headingId).toBe("details");
  });

  test("短于两字的查询不搜索（噪声与成本）", () => {
    const root = mount(PROSE);
    const { result } = run(root, "e");
    expect(result.matches).toHaveLength(0);
    expect(result.activeMatchIndex).toBe(-1);
    const blank = run(root, "   ");
    expect(blank.result.matches).toHaveLength(0);
  });

  test("无命中时 activeMatchIndex 为 -1", () => {
    const root = mount(PROSE);
    expect(run(root, "zzzz").result.activeMatchIndex).toBe(-1);
  });
});

describe("排除范围（§9.4 末段）", () => {
  test("图形化子树不进匹配：SVG 里的 text 不是散文", () => {
    // 夹具照 diagram-layer 的真实产物写：包裹层 + 容器 + svg + 保留的源码 pre。
    const root = mount(
      `<p>flow is prose</p>
       <div class="readora-diagram" data-readora-diagram-state="rendered">
         <div class="readora-diagram-container"><svg><text>flow</text></svg>
           <pre class="readora-diagram-source">flowchart TD["flow"]</pre>
         </div>
       </div>`
    );
    const { result } = run(root, "flow");
    // 只算正文那一次：SVG 与源码里的同名片段不能变成额外结果
    expect(result.matches.length).toBe(1);
    expect(result.matches[0]?.text).toBe("flow");
    const svgOnly = mount(`<svg><text>onlyinside</text></svg>`);
    expect(run(svgOnly, "onlyinside").result.matches).toHaveLength(0);
  });

  test("图表尚未落地（pending）时留在容器里的源码同样不可搜", () => {
    const root = mount(
      `<p>prose mentions scrollIntoView once</p>
       <div class="readora-diagram" data-readora-diagram-state="pending">
         <div class="readora-diagram-container">
           <pre class="readora-diagram-source">flowchart TD\n  C[scrollIntoView]</pre>
         </div>
       </div>`
    );
    expect(run(root, "scrollIntoView").result.matches.length).toBe(1);
  });

  test("交互层自己生成的节点不是文档内容", () => {
    const root = mount(
      `<div class="readora-code-block"><button data-readora-copy>Copy</button><pre>Copy me</pre></div>`
    );
    const { result } = run(root, "Copy");
    expect(result.matches.length).toBe(1);
    expect(result.matches[0]?.text).toBe("Copy");
  });

  test("公式渲染失败降级成源码文本时仍可搜（M6 预留位为空）", () => {
    expect(excludedSelector()).not.toContain("math");
    const root = mount(`<pre class="readora-math-fallback">E = mc^2</pre>`);
    expect(run(root, "mc^2").result.matches.length).toBe(1);
  });

  test("编辑器接管后 pre 仍是唯一可搜源，宿主里那份同内容不二次计数（M8）", () => {
    // CodeMirror 只渲染视口内的行，拿它的 DOM 去搜会漏命中；旁边那份完整的
    // `<pre>` 已在可搜范围内，所以必须排掉宿主：不排则数重，误删 pre 则数漏。
    const root = mount(
      `<div class="readora-code-block" data-readora-code-editor-state="mounted">
         <pre class="readora-code-pre"><code>const engine = 1\nreturn engine</code></pre>
         <div class="readora-code-editor"><div class="cm-editor"><div class="cm-scroller">
           <div class="cm-gutters">1</div><div class="cm-content">const engine = 1</div>
         </div></div></div>
       </div>`
    );
    expect(excludedSelector()).toContain(".readora-code-editor");
    expect(run(root, "engine").result.matches.length).toBe(2);
  });

  test("代码块里的高亮标记落在 pre 内（搜索命中时回显静态视图靠这条）", () => {
    // markdown.css 的 `:has(.readora-code-pre .readora-search-hit)` 要求 mark 必须是 pre
    // 的后代：命中的那块临时收起编辑器、显形静态视图，不然命中点被遮在 hidden 里。
    const root = mount(
      `<div class="readora-code-block" data-readora-code-editor-state="mounted">
         <pre class="readora-code-pre"><code>const engine = 1</code></pre>
         <div class="readora-code-editor"><div class="cm-editor"><div class="cm-content">const engine = 1</div></div></div>
       </div>`
    );
    const outcome = run(root, "engine");
    expect(applyHighlights(root, outcome, 7)).toBe(1);
    const mark = root.querySelector(`.${SEARCH_HIT_CLASS}`);
    expect(mark?.closest(".readora-code-pre")).not.toBeNull();
    expect(mark?.closest(".readora-code-editor")).toBeNull();
  });

  test("编辑冲突卡片不进索引：卡片里是未提交的输入不是文档内容（E2）", () => {
    // 卡片由接管层造，带一段草稿与几枚动作按钮。不排它则「命中计数」与文件里的
    // 字对不上，而且按计数往下跳时落点根本不在正文里（与 code-editor 同一个坑）。
    expect(excludedSelector()).toContain(`.${EDIT_CONFLICT_CLASS}`);
    const root = mount(
      `<p class="readora-paragraph" data-readora-source-range="2:2" data-readora-editable="paragraph">engine 在正文</p>
       <div class="${EDIT_CONFLICT_CLASS}" role="status" data-readora-edit-reason="search">
         <p class="readora-edit-conflict-reason">engine 还没提交</p>
         <button type="button">Continue editing</button>
       </div>`
    );
    const outcome = run(root, "engine");
    expect(outcome.result.matches.length).toBe(1);
    // 排的是卡片子树，不是被认领的区块：把手属性得照常可搜
    expect(applyHighlights(root, outcome, 7)).toBe(1);
    expect(root.querySelectorAll(`.${SEARCH_HIT_CLASS}`)).toHaveLength(1);
    expect(root.querySelector(`.${EDIT_CONFLICT_CLASS}`)?.querySelector("mark")).toBeNull();
    clearHighlights(root);
    expect(root.querySelector("p.readora-paragraph")?.textContent).toBe("engine 在正文");
  });
});

describe("高亮与还原（§9.4 第 1、4 条）", () => {
  test("高亮写入受控 mark 节点，带 id 与版本", () => {
    const root = mount(PROSE);
    const outcome = run(root, "engine");
    expect(applyHighlights(root, outcome, 7)).toBe(4);
    const marks = root.querySelectorAll("mark");
    expect(marks).toHaveLength(4);
    for (const mark of marks) {
      expect(mark.classList.contains(SEARCH_HIT_CLASS)).toBe(true);
      expect(mark.getAttribute(SEARCH_HIT_VERSION_ATTRIBUTE)).toBe("7");
    }
    expect(highlightVersion(root)).toBe(7);
    expect(root.getAttribute(DOCUMENT_VERSION_ATTRIBUTE)).toBeNull();
  });

  test("还原后正文逐字符回到搜索前（不破坏原始 DOM）", () => {
    const root = mount(PROSE);
    const before = root.textContent ?? "";
    const outcome = run(root, "engine");
    applyHighlights(root, outcome, 7);
    expect(root.textContent).toBe(before);
    clearHighlights(root);
    expect(root.textContent).toBe(before);
    expect(root.querySelectorAll("mark")).toHaveLength(0);
    // 节点合并回原状：相邻文本归一，不留碎片
    expect(highlightVersion(root)).toBeNull();
    // 还原后重搜，结果与计数稳定（§13「不重复构建整份文档」的前提）
    expect(run(root, "engine").result.matches.length).toBe(4);
  });

  test("跨节点命中拆成同 id 的多段，还原后仍然逐字符相等", () => {
    const root = mount(`<p>abc<strong>de</strong>f tail</p>`);
    const before = root.textContent ?? "";
    const outcome = run(root, "cdef");
    expect(outcome.result.matches.length).toBe(1);
    const inserted = applyHighlights(root, outcome, 1);
    expect(inserted).toBeGreaterThan(1);
    const marks = root.querySelectorAll("mark");
    expect(marks).toHaveLength(3);
    for (const mark of marks) {
      expect(mark.getAttribute(SEARCH_HIT_ID_ATTRIBUTE)).toBe(
        outcome.result.matches[0]?.id
      );
    }
    expect(root.textContent).toBe(before);
    clearHighlights(root);
    expect(root.textContent).toBe(before);
  });

  test("用户输入只当普通文本，不被拼进 HTML（§9.4 第 2 条）", () => {
    const root = mount(`<p>plain &lt;img&gt; text and <img src="x"> too</p>`);
    const before = root.textContent ?? "";
    // 查询串里的尖括号匹配的是解码后的正文，而不是标签语法
    const outcome = run(root, "<img>");
    expect(outcome.result.matches.length).toBe(1);
    expect(applyHighlights(root, outcome, 3)).toBe(1);
    expect(root.querySelectorAll("img")).toHaveLength(1);
    clearHighlights(root);
    expect(root.textContent).toBe(before);
    expect(root.querySelector("mark")).toBeNull();
    expect(root.querySelectorAll("img")).toHaveLength(1);
  });

  test("未先还原就重搜：旧高亮子树被排除，不产生二次命中", () => {
    const root = mount(PROSE);
    const first = run(root, "engine");
    applyHighlights(root, first, 7);
    const again = run(root, "engine");
    expect(again.result.matches).toHaveLength(0);
    clearHighlights(root);
    expect(run(root, "engine").result.matches.length).toBe(4);
  });

  test("版本标记供 §9.4 第 3 条的失效判定", () => {
    const root = mount(PROSE);
    applyHighlights(root, run(root, "engine"), 12);
    expect(highlightVersion(root)).toBe(12);
    expect(highlightVersion(root) === 13).toBe(false);
  });
});

describe("活动命中（PRD-002 §10.3）", () => {
  test("同一命中的多个片段共享 active 标记，其余片段复位", () => {
    const root = mount(`<p>abc<strong>de</strong>f tail abcdef</p>`);
    const outcome = run(root, "abcdef");
    applyHighlights(root, outcome, 1);
    const [first, second] = outcome.result.matches;
    expect(activateMatch(root, first?.id ?? "")).toBe(true);
    expect(
      root.querySelectorAll(`mark[${SEARCH_ACTIVE_ATTRIBUTE}="true"]`).length
    ).toBeGreaterThan(1);
    expect(activateMatch(root, second?.id ?? "")).toBe(true);
    const active = Array.from(
      root.querySelectorAll(`mark[${SEARCH_ACTIVE_ATTRIBUTE}="true"]`)
    );
    expect(
      active.every(
        (node) => node.getAttribute(SEARCH_HIT_ID_ATTRIBUTE) === second?.id
      )
    ).toBe(true);
    expect(activateMatch(root, "no-such-hit")).toBe(false);
  });
});

describe("截断与计数（§13 不阻塞主线程）", () => {
  test("达到上限即截断，计数位改口 999+", () => {
    const root = mount(`<p>${"ab ".repeat(MAX_SEARCH_HITS + 20)}</p>`);
    const { result } = run(root, "ab");
    expect(result.matches.length).toBe(MAX_SEARCH_HITS);
    expect(isTruncated(result.matches.length)).toBe(true);
    expect(formatMatchCount(result.matches.length)).toBe("999+");
    expect(formatMatchCount(12)).toBe("12");
    expect(isTruncated(4999)).toBe(false);
  });
});
