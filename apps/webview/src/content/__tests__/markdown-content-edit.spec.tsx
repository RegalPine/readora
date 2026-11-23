/**
 * 编辑接管层与渲染管线的接线取证（ARC-009 §8，E2）。
 *
 * `MarkdownContent` 是 innerHTML 的唯一作者，附加层的接管顺序与「什么信号重建层」
 * 都在它手里，所以这四件事必须由这一份 spec 钉住：
 * 1. **edit 在 code 之前**（§8 表）：CodeMirror 会替换掉 `<pre>` 那一族节点，
 *    接管层排在它后面就永远看不到自己该看的区块；本轮认领的四类不与代码块重合，
 *    但顺序是契约，将来 E4 把 `codeBlock` 翻成可编辑时靠的就是它。
 * 2. **正文重写不重建 edit 层**：它持有刚从旧 DOM 摘下来的节点，重建等于丢输入。
 * 3. **editMode 切换不重建任何层**：点一下开关不该等于刷一次整篇（阅读位置与
 *    已挂载的图表实例都在那次重排里）。
 * 4. **resetForDocument 只在换文档时触发**。
 *
 * 取证手法：把 `createEditLayer` / `createCodeEditorLayer` 包一层记录调用的替身，
 * 内部仍跑真实实现（`importOriginal`），于是 DOM 侧的断言与调用序列的断言同源。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { DocumentEditResult } from "@readora/contracts";
import { MarkdownContent, type MarkdownContentProps } from "../MarkdownContent";
import type { EditLayer, EditPort } from "../edit/edit-layer";
import { EDITABLE_ATTRIBUTE } from "../edit/edit-unit";
import { EDIT_TOOLBAR_CLASS } from "../edit/format-toolbar";
import type { ContentInteractionHandlers } from "../interactions";
import { fakeHandlers } from "./test-support";

const log = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("../edit/edit-layer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../edit/edit-layer")>();
  return {
    ...actual,
    createEditLayer(options: Parameters<typeof actual.createEditLayer>[0]): EditLayer {
      const real = actual.createEditLayer(options);
      log.calls.push("edit:create");
      return {
        scan(container) {
          log.calls.push("edit:scan");
          real.scan(container);
        },
        detachForRewrite() {
          log.calls.push("edit:detach");
          real.detachForRewrite();
        },
        setEditMode(on) {
          log.calls.push("edit:mode");
          real.setEditMode(on);
        },
        setAvailable(on) {
          log.calls.push("edit:available");
          real.setAvailable(on);
        },
        setSuspended(on) {
          log.calls.push("edit:suspended");
          real.setSuspended(on);
        },
        suspend() {
          log.calls.push("edit:suspend");
          real.suspend();
        },
        resetForDocument() {
          log.calls.push("edit:reset");
          real.resetForDocument();
        },
        destroy() {
          log.calls.push("edit:destroy");
          real.destroy();
        },
        snapshot() {
          return real.snapshot();
        }
      };
    }
  };
});

vi.mock("../code-editor/code-editor-layer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../code-editor/code-editor-layer")>();
  return {
    ...actual,
    createCodeEditorLayer() {
      const real = actual.createCodeEditorLayer();
      log.calls.push("code:create");
      return {
        ...real,
        scan(container: HTMLElement) {
          log.calls.push("code:scan");
          real.scan(container);
        },
        destroy() {
          log.calls.push("code:destroy");
          real.destroy();
        }
      };
    }
  };
});

const FILE_URI = "file:///vault/notes/doc.md";
const UNTITLED_URI = "untitled:Untitled-1";

const TEXT = "# 标题\n\n第一段。\n\n```js\nlet a = 1\n```\n\n第二段。\n";

let handlers: ContentInteractionHandlers = fakeHandlers();

function port(submit?: () => Promise<DocumentEditResult>): EditPort {
  return {
    submit: submit ?? (async () => ({ version: 2 })),
    documentUri: () => FILE_URI,
    version: () => 1
  };
}

function propsFor(input: {
  text?: string;
  version?: number;
  documentId?: string;
  documentUri?: string;
  editMode?: boolean;
  editSuspended?: boolean;
  editLayerRef?: MarkdownContentProps["editLayerRef"];
}): MarkdownContentProps {
  const id = input.documentId ?? input.documentUri ?? FILE_URI;
  return {
    documentId: id,
    documentUri: input.documentUri ?? id,
    version: input.version ?? 1,
    text: input.text ?? TEXT,
    theme: "light",
    handlers,
    editPort: port(),
    editMode: input.editMode ?? false,
    editSuspended: input.editSuspended ?? false,
    ...(input.editLayerRef ? { editLayerRef: input.editLayerRef } : {})
  };
}

function mount(input: Parameters<typeof propsFor>[0]) {
  const view = render(<MarkdownContent {...propsFor(input)} />);
  const container = view.container.querySelector<HTMLDivElement>(".readora-document");
  if (!container) {
    throw new Error("readora-document container missing");
  }
  return { view, container };
}

function count(label: string): number {
  return log.calls.filter((call) => call === label).length;
}

beforeEach(() => {
  log.calls.length = 0;
  handlers = fakeHandlers();
});

afterEach(() => {
  cleanup();
});

describe("接管顺序与重建边界", () => {
  test("edit 在 code 之前接管，两者都只接管一次", () => {
    mount({});
    expect(log.calls.indexOf("edit:scan")).toBeGreaterThan(-1);
    expect(log.calls.indexOf("edit:scan")).toBeLessThan(log.calls.indexOf("code:scan"));
    expect(count("edit:create")).toBe(1);
    expect(count("edit:scan")).toBe(1);
  });

  test("editMode 开启只转给接管层，不重建任何一层（§7.2）", () => {
    const { view, container } = mount({});
    view.rerender(<MarkdownContent {...propsFor({ editMode: true })} />);
    expect(count("edit:create")).toBe(1);
    expect(count("edit:scan")).toBe(1);
    expect(count("code:create")).toBe(1);
    expect(log.calls).toContain("edit:available");
    expect(log.calls).toContain("edit:mode");
    // 开关的真实效果只落在属性上：正文里那些块一个都没被重排。
    expect(container.querySelectorAll(`[${EDITABLE_ATTRIBUTE}]`).length).toBeGreaterThan(0);
    expect(container.querySelector("p[data-readora-editable='paragraph']")).not.toBeNull();
    expect(container.querySelector("pre")?.hasAttribute(EDITABLE_ATTRIBUTE)).toBe(false);
  });

  test("关掉的开关把把手摘净，正文回到静态形态", () => {
    const { view, container } = mount({ editMode: true });
    expect(container.querySelector(`[${EDITABLE_ATTRIBUTE}]`)).not.toBeNull();
    view.rerender(<MarkdownContent {...propsFor({ editMode: false })} />);
    expect(container.querySelector(`[${EDITABLE_ATTRIBUTE}]`)).toBeNull();
  });

  test("不可写文档：available 为假，一个把手都不给", () => {
    const { container } = mount({ editMode: true, documentUri: UNTITLED_URI });
    expect(container.querySelector(`[${EDITABLE_ATTRIBUTE}]`)).toBeNull();
  });

  test("同文档的新快照：先摘后扫，edit 层不重建，代码层重建", () => {
    const { view } = mount({});
    log.calls.length = 0;
    view.rerender(
      <MarkdownContent {...propsFor({ text: `${TEXT}\n补一段。\n`, version: 2 })} />
    );
    expect(log.calls.indexOf("edit:detach")).toBeLessThan(log.calls.indexOf("edit:scan"));
    expect(log.calls.indexOf("edit:detach")).toBeLessThan(log.calls.indexOf("code:destroy"));
    expect(count("edit:create")).toBe(0);
    expect(count("code:create")).toBe(1);
    expect(log.calls).not.toContain("edit:reset");
    expect(log.calls).not.toContain("edit:destroy");
  });

  test("换文档才 resetForDocument", () => {
    const { view } = mount({});
    log.calls.length = 0;
    view.rerender(
      <MarkdownContent {...propsFor({ documentId: "file:///vault/other.md", version: 1 })} />
    );
    expect(log.calls).toContain("edit:reset");
  });

  test("editSuspended 只转信号，不重建不重排", () => {
    const { view } = mount({ editMode: true });
    log.calls.length = 0;
    view.rerender(<MarkdownContent {...propsFor({ editMode: true, editSuspended: true })} />);
    expect(log.calls).toEqual(["edit:suspended"]);
  });

  test("卸载才 destroy 接管层", () => {
    const { view } = mount({ editMode: true });
    expect(log.calls).not.toContain("edit:destroy");
    view.unmount();
    expect(log.calls).toContain("edit:destroy");
  });

  test("没给 editPort 就完全不接管正文（旧调用点零影响）", () => {
    log.calls.length = 0;
    const view = render(
      <MarkdownContent
        documentId={FILE_URI}
        documentUri={FILE_URI}
        version={1}
        text={TEXT}
        theme="light"
        handlers={handlers}
        editMode
      />
    );
    const container = view.container.querySelector<HTMLDivElement>(".readora-document");
    expect(count("edit:create")).toBe(0);
    expect(container?.querySelector(`[${EDITABLE_ATTRIBUTE}]`)).toBeNull();
  });
});

describe("格式化工具条不越过接管层的生命周期（E3 / 决策 4 的代价）", () => {
  /** 工具条挂在 `body` 上，所以上下文不是正文容器而是整个文档。 */
  function toolbars(): number {
    return document.body.querySelectorAll(`.${EDIT_TOOLBAR_CLASS}`).length;
  }

  function openUnit(container: HTMLElement): void {
    const block = container.querySelector<HTMLElement>("p[data-readora-editable='paragraph']");
    if (!block) {
      throw new Error("editable paragraph missing");
    }
    block.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  }

  test("激活才出现，正文重写与卸载都收干净", () => {
    const { view, container } = mount({ editMode: true });
    expect(toolbars()).toBe(0);
    openUnit(container);
    expect(toolbars()).toBe(1);
    // 新快照到达：detachForRewrite → innerHTML → scan。工具条挂在 body 上，
    // 不会被那次 innerHTML 端掉 —— 收不掉就是接管层漏了一条（本文件存在的理由）。
    view.rerender(
      <MarkdownContent {...propsFor({ editMode: true, text: `${TEXT}\n补一段。\n`, version: 2 })} />
    );
    expect(toolbars()).toBe(0);
    openUnit(container);
    expect(toolbars()).toBe(1);
    view.unmount();
    expect(toolbars()).toBe(0);
  });

  test("editMode 没开：双击不激活，也就不可能浮出一枚工具条", () => {
    const { container } = mount({});
    container
      .querySelector("p")
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(toolbars()).toBe(0);
  });
});

describe("editLayerRef 交回接管层（导出前挂起要用，ARC-008 §16.1）", () => {
  test("挂载后 ref 指向那一层，卸载后置空", () => {
    const ref = { current: null as EditLayer | null };
    const props = propsFor({ editMode: true, editLayerRef: ref });
    const view = render(<MarkdownContent {...props} />);
    expect(ref.current).not.toBeNull();
    // 导出前那条 `suspend()` 走的就是交回来的这一个对象。
    const before = ref.current;
    view.unmount();
    expect(before).toBeDefined();
    expect(ref.current).toBeNull();
  });
});
