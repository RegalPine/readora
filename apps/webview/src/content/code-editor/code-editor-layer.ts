/**
 * 代码编辑器接管层（ARC-002 §8 的编辑器化改造，M8）。
 *
 * 与图表层同一条设计线：**markdown-core 的静态产物永远是真相**，本层只做接管与降级。
 *
 * - 源码取自 `<pre class="readora-code-pre">` 的 textContent，不新增 data 属性、
 *   不扩大 Sanitizer 可信面（与 diagram-layer 同口径）；
 * - **静态 `<pre>` 保留在 DOM 里**，挂载成功后由 CSS 隐藏：它是文档内搜索唯一的
 *   可搜文本源（CodeMirror 只渲染视口内的行，拿它的 DOM 去搜索会漏命中）；
 *   搜索命中落进块里时，markdown.css 的 `:has(.readora-code-pre .readora-search-hit)`
 *   那条把静态视图临时显形、把编辑器暂时收起 —— 于是「命中位置看得见」和
 *   「编辑器是主视图」两件事同时成立，不需要搜索层知道编辑器存在；
 * - 懒挂载：进入视口（含 400px 余量）才建实例，长文档首屏不铺 N 个编辑器；
 * - 无 IntersectionObserver 的环境（jsdom）退化为立即挂载，交给注入的 createEditor 断言；
 * - 挂载失败只降级这一块：删掉宿主、标 `failed`，静态高亮照常显示，不影响其它块；
 * - 复制按钮不用改：`interactions.ts` 读的是 `pre code` 的 textContent，两个视图同源。
 *
 * 状态写在 `data-readora-code-editor-state`（pending / mounted / failed），
 * 样式与测试共用这一个口径。
 */
import { codeFolding, foldGutter } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { grammarFor } from "./languages";
import { readoraEditorTheme, readoraHighlightExtension } from "./theme";
import { createLazyObserver, type ObserverFactory, type ObserverHandle } from "../viewport";

export const CODE_EDITOR_STATE_ATTRIBUTE = "data-readora-code-editor-state";
export const CODE_BLOCK_SELECTOR = ".readora-code-block";
export const CODE_EDITOR_HOST_CLASS = "readora-code-editor";
const PRE_SELECTOR = ".readora-code-pre";
const CODE_SELECTOR = "code";
const LANG_ATTRIBUTE = "data-readora-code-lang";

/** 懒挂载视口余量：编辑器建实例比图表便宜（无外部解析器加载），但也不该首屏全量铺。 */
export const CODE_EDITOR_ROOT_MARGIN = "400px";

export type CodeEditorLayerState = "pending" | "mounted" | "failed";

export interface CodeEditorInit {
  /** 代码正文（已去掉围栏尾部那一个换行，见 stripTrailingNewline）。 */
  source: string;
  /** 围栏语言位原样传进来，由语法表负责认别名；无语法时为 null。 */
  language: string | null;
}

export interface CodeEditorHandle {
  destroy(): void;
  /** 字体度量变了要请编辑器重测（字号偏好走这里，主题变化不走）。 */
  requestMeasure(): void;
}

export interface CodeEditorLayerDeps {
  /** 编辑器注入点：单测换成替身，jsdom 里没有真实布局也能断言整条状态机。 */
  createEditor?: (host: HTMLElement, init: CodeEditorInit) => CodeEditorHandle;
  /** 观察器注入点：无 IntersectionObserver 的环境退化为立即激活。 */
  createObserver?: ObserverFactory;
}

export interface CodeEditorLayer {
  /** 扫描容器内代码块；重复调用幂等，已接管的块不重复挂载。 */
  scan(container: Element): number;
  /** 字号一类的度量变化：请每个实例重测行高，不重建文档。 */
  refreshAll(): void;
  /** 当前接管的实例数（测试与 harness 取证用）。 */
  readonly instanceCount: number;
  stateOf(block: Element): CodeEditorLayerState | null;
  destroy(): void;
}

interface CodeEditorRecord {
  block: HTMLElement;
  host: HTMLElement;
  handle: CodeEditorHandle | null;
}

/**
 * 默认编辑器实现：真 CodeMirror。
 *
 * `editable: false` + `readOnly`：鼠标可以选择、可以 Ctrl+C 复制（选中面由编辑器画），
 * 但键盘输入与 IME 改不动正文 —— 读者选中文本时的第一动作是复制，不是编辑。
 * 行号在 view 包（`lineNumbers`）、折叠在 language 包（`foldGutter` + `codeFolding`），
 * 这个包名分布直接照官方分包写，不做一层 re-export 屏蔽（多一层文件不省钱）。
 */
export function createCodeMirrorEditor(host: HTMLElement, init: CodeEditorInit): CodeEditorHandle {
  const grammar = grammarFor(init.language);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: init.source,
      extensions: [
        grammar ? grammar.extension : [],
        readoraEditorTheme(),
        readoraHighlightExtension(),
        lineNumbers(),
        foldGutter(),
        codeFolding(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({ spellcheck: "false" })
      ]
    })
  });
  return {
    destroy: () => view.destroy(),
    requestMeasure: () => view.requestMeasure()
  };
}

/**
 * 去掉围栏尾部那一个换行。
 *
 * markdown-it 交出的 code 值以 `\n` 结尾，`<pre>` 按 CSS 规则不显示这最后一个空行，
 * 而编辑器的文档模型会老老实实多出第 N+1 行 —— 于是「行号 8 行」与「静态视图 7 行」
 * 对不上。这里只削掉尾部一个换行（多个空行是文档作者写在代码里的，保留）。
 * 名字不叫 normalizeSource：markdown-core 已经占了这个名字做行数统计。
 */
export function stripTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

export function createCodeEditorLayer(deps: CodeEditorLayerDeps = {}): CodeEditorLayer {
  const makeEditor = deps.createEditor ?? createCodeMirrorEditor;
  const records = new Map<HTMLElement, CodeEditorRecord>();
  const observer: ObserverHandle | null = (deps.createObserver ?? createLazyObserver)(
    activate,
    { rootMargin: CODE_EDITOR_ROOT_MARGIN }
  );

  function setState(block: HTMLElement, state: CodeEditorLayerState): void {
    block.setAttribute(CODE_EDITOR_STATE_ATTRIBUTE, state);
  }

  /** 交给编辑器：先取正文、建宿主、再实例化；任何一步抛错都只降级这一块。 */
  function mountInto(record: CodeEditorRecord): void {
    const block = record.block;
    const pre = block.querySelector(PRE_SELECTOR);
    const code = pre?.querySelector(CODE_SELECTOR) ?? pre;
    const text = code?.textContent;
    if (!pre || text === undefined || text.length === 0) {
      // 空块（或结构异常）不值得起一个编辑器：标失败，静态视图原样留着。
      record.host.remove();
      records.delete(block);
      setState(block, "failed");
      return;
    }
    const language = block.getAttribute(LANG_ATTRIBUTE);
    try {
      record.handle = makeEditor(record.host, {
        source: stripTrailingNewline(text),
        language: language === null || language === "" ? null : language
      });
    } catch {
      // 引擎构造失败（浏览器内核过旧、布局异常）同样只降这一块。
      record.handle = null;
      record.host.remove();
      records.delete(block);
      setState(block, "failed");
      return;
    }
    setState(block, "mounted");
    observer?.unobserve(block);
  }

  function activate(block: HTMLElement): void {
    const record = records.get(block);
    if (!record || record.handle) {
      return;
    }
    mountInto(record);
  }

  return {
    scan(container) {
      let added = 0;
      for (const element of container.querySelectorAll(CODE_BLOCK_SELECTOR)) {
        const block = element as HTMLElement;
        if (records.has(block)) {
          // 重复 scan（同文档重写、可见性变化）必须幂等：同一块不能起两个编辑器。
          continue;
        }
        const host = document.createElement("div");
        host.className = CODE_EDITOR_HOST_CLASS;
        const pre = block.querySelector(PRE_SELECTOR);
        if (!pre) {
          continue;
        }
        pre.after(host);
        records.set(block, { block, host, handle: null });
        setState(block, "pending");
        added += 1;
        if (observer) {
          observer.observe(block);
        } else {
          // 无 IntersectionObserver：立即挂载，行为与图表层在 jsdom 里的退化一致。
          activate(block);
        }
      }
      return added;
    },

    refreshAll() {
      for (const record of records.values()) {
        record.handle?.requestMeasure();
      }
    },

    get instanceCount() {
      return [...records.values()].filter((record) => record.handle !== null).length;
    },

    stateOf(block) {
      const state = block.getAttribute(CODE_EDITOR_STATE_ATTRIBUTE);
      return state === "pending" || state === "mounted" || state === "failed" ? state : null;
    },

    destroy() {
      observer?.disconnect();
      for (const record of records.values()) {
        try {
          record.handle?.destroy();
        } catch {
          // 卸载路径上的销毁异常不该拖垮正文重写：实例本来就要随 DOM 一起消失。
        }
        record.host.remove();
      }
      records.clear();
    }
  };
}
