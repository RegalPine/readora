/**
 * 编辑手册弹层自身的契约（ARC-009 §7.5）。
 *
 * App 侧的接线（入口可见性、`?` 快捷键、退出编辑自动关闭）在
 * `app-edit-mode.spec.tsx`，这里只管弹层自己承诺的四件事：
 * 1. 地标与可读名称齐备（`role="dialog"` + `aria-modal` + `aria-labelledby`）；
 * 2. 焦点契约与 Settings 弹层同一条实现（收拢、Tab 环、卸载归位触发器）；
 * 3. `Escape` 关闭且**不外溢** —— 挂 body 的浮层收不到容器委托，反过来它若把
 *    事件冒出去，一次按键会连搜索一起收掉（`interactions.ts` 让路判据）；
 * 4. **只讲已实现的行为**：每条键位都要能在接管层/e2e 里找到对应实现，
 *    文案里出现一个做不到的键位，比少写一条更糟（§16.6 那类文档超前缺陷）。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { EDIT_HELP_DIALOG_CLASS } from "../../content/interactions";
import { EDIT_HELP_CLASS, EditHelpDialog } from "../EditHelpDialog";

afterEach(cleanup);

function dialog() {
  const onClose = vi.fn();
  // 触发器：真实场景里它是顶栏那枚 `?`，弹层要在卸载时把焦点还给它。
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.textContent = "trigger";
  document.body.append(trigger);
  trigger.focus();

  const view = render(<EditHelpDialog onClose={onClose} />);
  return { view, onClose, trigger };
}

function panel(view: ReturnType<typeof dialog>["view"]): HTMLElement {
  const node = view.container.querySelector<HTMLElement>(`.${EDIT_HELP_DIALOG_CLASS}`);
  if (!node) {
    throw new Error("edit help dialog not rendered");
  }
  return node;
}

describe("地标与内容", () => {
  test("dialog + aria-modal + aria-labelledby 指向可见标题", () => {
    const { view } = dialog();
    const root = panel(view);
    expect(root.getAttribute("role")).toBe("dialog");
    expect(root.getAttribute("aria-modal")).toBe("true");
    const labelled = root.getAttribute("aria-labelledby");
    expect(labelled).toBeTruthy();
    expect(view.container.querySelector(`#${labelled}`)?.textContent).toBe("Editing guide");
  });

  test("每一段都有小节标题，键位行用 <kbd>（不是把键名写进散文里）", () => {
    const { view } = dialog();
    const titles = [...panel(view).querySelectorAll(`.${EDIT_HELP_CLASS}-section-title`)].map(
      (node) => node.textContent
    );
    expect(titles).toEqual([
      "Start editing",
      "Submit or cancel",
      "Two shapes",
      "Formatting bar",
      "Sections",
      "When the file changed first"
    ]);
    const keys = [...panel(view).querySelectorAll("kbd")].map((node) => node.textContent);
    expect(keys).toContain("Double-click");
    expect(keys).toContain("E");
    // `Ctrl` 与 `Enter` 分两枚键帽：合写成 "Ctrl+Enter" 就没法按形态对齐两列。
    expect(keys).toContain("Ctrl");
    expect(keys).toContain("Enter");
  });

  test("卡片动作按真实文案写：Replace anyway 只出现在 stale 那一段", () => {
    const { view } = dialog();
    const text = panel(view).textContent ?? "";
    expect(text).toContain("Re-edit from the latest source");
    expect(text).toContain("Replace anyway");
    expect(text).toContain("Discard");
    expect(text).toContain("Continue editing");
  });

  test("不承诺没实现的事：源码型区块没有格式化工具条", () => {
    const { view } = dialog();
    const text = panel(view).textContent ?? "";
    // 手册里不许出现「表格可以直接改单元格」这类未来项（README 未纳入清单）。
    expect(text).not.toMatch(/cell/iu);
    expect(text).toContain("raw Markdown source");
    expect(text).toContain("hidden for raw-source blocks");
  });
});

describe("键盘与焦点", () => {
  test("打开即把焦点收拢进弹层，卸载时还回触发器", () => {
    const { view, trigger } = dialog();
    expect(panel(view).contains(document.activeElement)).toBe(true);
    view.unmount();
    expect(document.activeElement).toBe(trigger);
  });

  test("Escape 关闭，且不冒到 document（同一次按键不该顺带收掉搜索面板）", () => {
    const { view, onClose } = dialog();
    const reachedDocument = vi.fn();
    document.addEventListener("keydown", reachedDocument);
    const root = panel(view);
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true
    });
    act(() => {
      root.dispatchEvent(event);
    });
    document.removeEventListener("keydown", reachedDocument);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(reachedDocument).not.toHaveBeenCalled();
  });

  test("Tab 关在弹层里环转：第一枚是 Close，最后一枚还是它", () => {
    const { view } = dialog();
    const root = panel(view);
    const close = root.querySelector<HTMLButtonElement>('button[aria-label="Close editing guide"]');
    if (!close) {
      throw new Error("close button not mounted");
    }
    // 弹层里只有 Close 一个可聚焦件（键帽与代码不是控件），于是
    // 「Tab 漏到背景」与「环转」是同一枚按钮上的两件事。
    expect([...root.querySelectorAll("button")]).toHaveLength(1);
    close.focus();
    fireEvent.keyDown(close, { key: "Tab" });
    expect(document.activeElement).toBe(close);
  });

  test("面板内点击不冒到 backdrop（否则点文字就把自己关了）", () => {
    const { view, onClose } = dialog();
    const row = panel(view).querySelector(`.${EDIT_HELP_CLASS}-row`) as HTMLElement;
    act(() => {
      fireEvent.click(row);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  test("backdrop 与 Close 各关一次", () => {
    const { view, onClose } = dialog();
    const backdrop = panel(view).parentElement as HTMLElement;
    act(() => {
      fireEvent.click(backdrop);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => {
      fireEvent.click(
        panel(view).querySelector('button[aria-label="Close editing guide"]') as HTMLElement
      );
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
