/**
 * 编辑模式帮助手册弹层（ARC-009 §7.1 / §7.5，E8 之后的补充入口）。
 *
 * 存在的理由是一条结构性的不对称：编辑模式**没有原生可对照的形态**。专注模式
 * 点错了至少知道自己看不见顶栏了，编辑模式点错了只是正文多了些选不中的角标 ——
 * 把手是 hover / focus 显形的，双击、`Ctrl+Enter`、`Escape` 这些和宿主编辑器
 * 习惯不同的键位，用户不读代码就猜不出来。ARC-009 §7.1 的入口表此前只服务实现者，
 * 这一层把它变成用户可随时调出的界面内说明。
 *
 * 三条口径：
 * 1. **只讲已实现的行为**：每一条都能在 `edit-layer.spec.ts` / `edit.spec.ts` 里
 *    找到对应断言；没实现的（表格单元格所见即所得、原文 HTML 编辑）不写，
 *    「手册比代码多说一句」正是 §16.6 登记过的那类文档超前缺陷。
 * 2. 焦点契约照 `ReaderSettingsDialog` 那一套（同仓库两处弹层各自发明键盘行为是
 *    迟早要漂移的差异），`focusableWithin` 直接引它那份而不是再写一遍。
 * 3. 面板带 `role="dialog"`，因此它天然在 `edit-unit.ts` 的 `KEEP_EDITING_SELECTOR`
 *    名单里 —— 正改着的块不会因为「点了 Help」被失焦提交（ARC-009 §7.4：
 *    `focusout` 是提交不是取消，这条路径必须避开它）。
 *
 * 文案口径与顶栏一致走英文（`Edit mode` / `Replace anyway` / `Continue editing`
 * 同一套），键位符号用 `<kbd>`，字面标记（`**粗**` 之类）用 `<code>`。
 */
import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";
import { EDIT_HELP_DIALOG_CLASS } from "../content/interactions";
import { CloseIcon, EditIcon } from "./Icon";
import { focusableWithin } from "./ReaderSettingsDialog";

export const EDIT_HELP_CLASS = "readora-edit-help";

export interface EditHelpDialogProps {
  onClose(): void;
}

export function EditHelpDialog({ onClose }: EditHelpDialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<Element | null>(null);

  // 打开时记下触发器（此刻它是 activeElement），卸载时还回去 —— 与 Settings 弹层
  // 同一条焦点归位实现，不依赖父子之间再传一个 ref。
  useEffect(() => {
    restoreRef.current = document.activeElement;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      const target = restoreRef.current;
      if (target instanceof HTMLElement && typeof target.focus === "function") {
        target.focus({ preventScroll: true });
      }
    };
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        // `stopPropagation` + `preventDefault` 两条都要：前者挡住单元内与工具条里
        // 那些 Escape 监听（这一层没有活动单元，但冒泡路径将来会变），后者兑现
        // `interactions.ts` 的「已 preventDefault 就让路」，免得一次 Escape
        // 同时收掉手册与搜索面板。
        event.stopPropagation();
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const panel = panelRef.current;
      if (!panel) {
        return;
      }
      const focusable = focusableWithin(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      const active = document.activeElement;
      if (!panel.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  return (
    <div className="readora-settings-backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className={EDIT_HELP_DIALOG_CLASS}
        role="dialog"
        aria-modal="true"
        aria-labelledby="readora-edit-help-title"
        tabIndex={-1}
        onClick={(event) => {
          // 面板内的点击不该冒泡到 backdrop 把自己关掉。
          event.stopPropagation();
        }}
        onKeyDown={onKeyDown}
      >
        <header className="readora-settings-header">
          <EditIcon size={14} />
          <h2 id="readora-edit-help-title" className="readora-settings-title">
            Editing guide
          </h2>
          <button
            type="button"
            className="readora-settings-close"
            aria-label="Close editing guide"
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </button>
        </header>

        <Section title="Start editing">
          <Row keys={["Double-click"]} text="a marked block — its corner shows on hover." />
          <Row keys={["Enter", "Space"]} text="activate the focused block." />
          <Row keys={["E"]} text="activate the focused block (same path as Enter)." />
          <p className={`${EDIT_HELP_CLASS}-hint`}>
            Marked blocks: paragraphs, headings, quotes, lists, code blocks, tables, diagrams and
            math. Nothing else shows an entry.
          </p>
        </Section>

        <Section title="Submit or cancel">
          <Row keys={["Ctrl", "Enter"]} text="write the block back to the file." />
          <Row keys={["Esc"]} text="cancel this block and put the original text back." />
          <Row
            keys={["Click outside"]}
            text={
              <>
                is a <b>submit</b>, not a cancel — use <kbd>Esc</kbd> to discard.
              </>
            }
          />
        </Section>

        <Section title="Two shapes">
          <Row
            keys={[]}
            text={
              <>
                Text blocks edit the words you see; markers (<Code>#</Code> <Code>&gt;</Code>{" "}
                <Code>-</Code>) are added back on submit.
              </>
            }
          />
          <Row
            keys={[]}
            text={
              <>
                Code, tables, diagrams and math always edit raw Markdown source — the rendered
                artifact is not kept in sync while you type.
              </>
            }
          />
        </Section>

        <Section title="Formatting bar">
          <Row
            keys={[]}
            text={
              <>
                Select text inside a block to reach <Code>B</Code> <Code>I</Code> <Code>S</Code>{" "}
                <Code>&lt;&gt;</Code> <Code>[]</Code> <Code>[^n]</Code>, heading levels{" "}
                <Code>H1</Code>–<Code>H6</Code> and <b>Cancel</b>.
              </>
            }
          />
          <Row
            keys={["ArrowLeft", "ArrowRight", "Home", "End"]}
            text="move between the bar’s controls."
          />
          <p className={`${EDIT_HELP_CLASS}-hint`}>
            The bar is hidden for raw-source blocks — markers make no sense in bare source.
          </p>
        </Section>

        <Section title="Sections">
          <Row
            keys={[]}
            text={
              <>
                In the outline, <b>⋯</b> next to a heading adds, renames or removes a section.
              </>
            }
          />
        </Section>

        <Section title="When the file changed first">
          <Row
            keys={[]}
            text={
              <>
                A rejected submit keeps your text in a card: <b>Re-edit from the latest source</b>,{" "}
                <b>Replace anyway</b> (stale only) and <b>Discard</b>.
              </>
            }
          />
          <Row
            keys={[]}
            text={
              <>
                Opening search suspends editing; <b>Continue editing</b> closes it and hands the
                draft back.
              </>
            }
          />
        </Section>

        <p className="readora-settings-note">
          Changes are written back to the block’s own source lines only — every byte you did not
          edit stays as it is. This guide is a session view: it closes when editing mode is off.
        </p>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={`${EDIT_HELP_CLASS}-section`}>
      <h3 className={`${EDIT_HELP_CLASS}-section-title`}>{title}</h3>
      <div className={`${EDIT_HELP_CLASS}-rows`}>{children}</div>
    </section>
  );
}

/**
 * 一行 = 键位列 + 说明列。
 *
 * `keys` 为空的那些行讲的是鼠标路径与形态，没有键位可列 —— 留空而不是造第二套
 * 版式，两列的基线才对得齐。
 */
function Row({ keys, text }: { keys: readonly string[]; text: ReactNode }) {
  return (
    <div className={`${EDIT_HELP_CLASS}-row`}>
      <span className={`${EDIT_HELP_CLASS}-keys`}>
        {keys.map((key) => (
          <kbd key={key} className={`${EDIT_HELP_CLASS}-key`}>
            {key}
          </kbd>
        ))}
      </span>
      <span className={`${EDIT_HELP_CLASS}-text`}>{text}</span>
    </div>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className={`${EDIT_HELP_CLASS}-code`}>{children}</code>;
}
