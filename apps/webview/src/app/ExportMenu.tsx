/**
 * 顶栏 Export 下拉菜单（M11 · PRD-003 §10.5 顶栏动作）。
 *
 * 三档格式在这里只是**意图的表达**：点一下只发 `export.request{format}`，既不本地
 * 序列化也不本地弹提示 —— 保存对话框是唯一的写盘授权边界（ARC-008），结果反馈的
 * 权威在 Host 的通知。菜单自己连一个文件字节都不碰。
 *
 * a11y 契约照 `ReaderSettingsDialog` 已验证的那一套走（同一个仓库里两处弹层各自
 * 发明键盘行为，是迟早要漂移的那种差异）：
 * 1. 挂载时焦点收拢进菜单，卸载时还回触发器（记住 `document.activeElement`，
 *    不依赖父子再传一个 ref）；
 * 2. `Escape` 关闭；
 * 3. `Tab` 关在菜单里环转，`ArrowUp/Down/Home/End` 在三项之间移动 —— `role="menu"`
 *    的读屏预期就是方向键选项目，只给 Tab 等于让键盘用户重新学一遍鼠标顺序。
 *
 * 与对话框不同的地方只有一处：菜单没有 backdrop。它挂在顶栏动作组里，压一层
 * 遮罩会把整条顶栏盖住，而「点外面关掉」用 `pointerdown` 捕获 + 包含判断就够了。
 */
import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from "react";
import type { ExportFormat } from "@readora/contracts";
import { focusableWithin } from "./ReaderSettingsDialog";

export const EXPORT_MENU_CLASS = "readora-export-menu";
/** 触发器的标识：verify 断言与 e2e 都按这个属性名找按钮（未被 mangle 的字面量）。 */
export const EXPORT_MENU_ATTRIBUTE = "data-readora-export-menu";

/** 三档格式与对外文案：顺序即锁定口径「HTML / PDF / PNG」。 */
export const EXPORT_FORMAT_ITEMS: readonly { format: ExportFormat; label: string }[] = [
  { format: "html", label: "Export as HTML" },
  { format: "pdf", label: "Export as PDF" },
  { format: "png", label: "Export as PNG" }
];

export interface ExportMenuProps {
  open: boolean;
  onSelect(format: ExportFormat): void;
  onClose(): void;
}

export function ExportMenu({ open, onSelect, onClose }: ExportMenuProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<Element | null>(null);
  /**
   * `onClose` 存进 ref：下面的副作用只跟 `open` 走。
   *
   * 不能拿 `onClose` 当依赖：调用方递过来的几乎总是内联箭头（每次渲染一个新身份），
   * 那会让副作用在任意一次重渲染上重跑 —— 菜单开着时滚动一下正文就把焦点抢回菜单，
   * 并且顺带多跑一次 cleanup（焦点归还）。副作用的领域只有「开合」，依赖就写这一个。
   */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) {
      return;
    }
    restoreRef.current = document.activeElement;
    panelRef.current?.focus({ preventScroll: true });
    // 捕获阶段听全局 pointerdown：菜单内点击不关，外面点击立刻关。用 pointerdown
    // 而不是 click，是为了与顶栏触发器自己的 onClick 错开一轮 —— 点到触发器上时
    // 这里先关掉，按钮的 onClick 随后再开，就会变成「点不开也关不掉」。
    const onPointerDown = (event: PointerEvent): void => {
      const panel = panelRef.current;
      const target = event.target;
      if (panel === null || !(target instanceof Node)) {
        return;
      }
      if (panel.contains(target)) {
        return;
      }
      const trigger = document.querySelector(`[${EXPORT_MENU_ATTRIBUTE}]`);
      if (trigger !== null && trigger.contains(target)) {
        return;
      }
      closeRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      const target = restoreRef.current;
      if (target instanceof HTMLElement && typeof target.focus === "function") {
        target.focus({ preventScroll: true });
      }
      restoreRef.current = null;
    };
  }, [open]);

  const moveFocus = useCallback((step: number): void => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const items = focusableWithin(panel);
    if (items.length === 0) {
      return;
    }
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = index === -1 ? (step > 0 ? 0 : items.length - 1) : (index + step + items.length) % items.length;
    (items[next] as HTMLElement).focus();
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        moveFocus(1);
        return;
      }
      if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        moveFocus(-1);
        return;
      }
      const panel = panelRef.current;
      if (!panel) {
        return;
      }
      const items = focusableWithin(panel);
      if (items.length === 0) {
        return;
      }
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      if (event.key === "Home") {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        last.focus();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      // Tab 环：与对话框同一判据，焦点在菜单外先收进来，走到末项再绕回首项。
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
    [moveFocus, onClose]
  );

  if (!open) {
    return null;
  }

  return (
    <div
      ref={panelRef}
      className={EXPORT_MENU_CLASS}
      role="menu"
      aria-label="Export document"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
        // 菜单自己的 pointerdown 不再往上冒：关闭判断已经在 document 捕获阶段做完。
        event.stopPropagation();
      }}
    >
      {EXPORT_FORMAT_ITEMS.map((item) => (
        <button
          key={item.format}
          type="button"
          role="menuitem"
          className={`${EXPORT_MENU_CLASS}-item`}
          data-readora-export-format={item.format}
          onClick={() => {
            onSelect(item.format);
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
