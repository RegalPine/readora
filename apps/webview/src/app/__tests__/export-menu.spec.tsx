/**
 * Export 下拉菜单测试（M11 · PRD-003 §10.5）。
 *
 * 两类断言各占一半：
 * - 「点了算什么」：三项各自回传正确 format，菜单自己不写文件、不发别的消息；
 * - 「键盘能不能用」：Esc、方向键、Home/End、Tab 环、焦点归还 —— 与 Settings 弹层
 *   同一套契约，两把尺子量一个仓库里的两个弹层是没有意义的。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ExportFormat } from "@readora/contracts";
import { EXPORT_MENU_ATTRIBUTE, EXPORT_MENU_CLASS, ExportMenu } from "../ExportMenu";

afterEach(cleanup);

const FORMATS = ["html", "pdf", "png"] as const;

function menu(props: {
  open?: boolean;
  onSelect?: (format: ExportFormat) => void;
  onClose?: () => void;
}) {
  const onSelect = props.onSelect ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  const view = render(
    <div>
      <button type="button" data-readora-export-menu="true">
        Export document
      </button>
      <ExportMenu open={props.open ?? true} onSelect={onSelect} onClose={onClose} />
    </div>
  );
  const trigger = view.container.querySelector<HTMLButtonElement>(
    `[${EXPORT_MENU_ATTRIBUTE}]`
  ) as HTMLButtonElement;
  const panel = view.container.querySelector<HTMLElement>(`.${EXPORT_MENU_CLASS}`);
  const items = [...(panel?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [])];
  return { view, trigger, panel, items, onSelect, onClose };
}

describe("渲染与载荷", () => {
  test("open=false 时菜单不在 DOM 里", () => {
    const { panel } = menu({ open: false });
    expect(panel).toBeNull();
  });

  test("菜单是 role=menu 且有可读名称", () => {
    const { panel } = menu({});
    expect(panel?.getAttribute("role")).toBe("menu");
    expect(panel?.getAttribute("aria-label")).toBe("Export document");
    expect(panel?.getAttribute("tabindex")).toBe("-1");
  });

  test("三项按 HTML / PDF / PNG 顺序给出，每项都是 menuitem", () => {
    const { items } = menu({});
    expect(items.map((item) => item.textContent)).toEqual([
      "Export as HTML",
      "Export as PDF",
      "Export as PNG"
    ]);
    expect(items.map((item) => item.getAttribute("data-readora-export-format"))).toEqual([
      "html",
      "pdf",
      "png"
    ]);
  });

  test("点击某一项只回传该档格式", () => {
    for (const [index, format] of FORMATS.entries()) {
      const { items, onSelect, onClose } = menu({});
      fireEvent.click(items[index] as HTMLButtonElement);
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(format);
      // 关闭由调用方决定（App 在 requestExport 里收菜单），菜单自己不越权 onClose。
      expect(onClose).not.toHaveBeenCalled();
    }
  });
});

describe("键盘契约", () => {
  test("打开时焦点收拢进菜单", () => {
    const { panel } = menu({});
    expect(document.activeElement).toBe(panel);
  });

  test("Escape 关闭", () => {
    const { panel, onClose } = menu({});
    fireEvent.keyDown(panel as HTMLElement, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("方向键在三项目之间环转", () => {
    const { panel, items } = menu({});
    const first = items[0] as HTMLButtonElement;
    const third = items[2] as HTMLButtonElement;
    fireEvent.keyDown(panel as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(panel as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(panel as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(third);
    // 末项再往下回到首项：菜单只有三项，键盘不该在此撞墙。
    fireEvent.keyDown(panel as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(panel as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(third);
  });

  test("Home / End 直达首末项", () => {
    const { panel, items } = menu({});
    fireEvent.keyDown(panel as HTMLElement, { key: "End" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(panel as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
  });

  test("Tab 关在菜单里：末项按 Tab 回首项，首项按 Shift+Tab 到末项", () => {
    const { panel, items } = menu({});
    (items[2] as HTMLButtonElement).focus();
    const forward = fireEvent.keyDown(panel as HTMLElement, { key: "Tab" });
    expect(forward).toBe(false);
    expect(document.activeElement).toBe(items[0]);
    const backward = fireEvent.keyDown(panel as HTMLElement, { key: "Tab", shiftKey: true });
    expect(backward).toBe(false);
    expect(document.activeElement).toBe(items[2]);
  });
});

describe("关闭与焦点归还", () => {
  test("菜单外的 pointerdown 关掉菜单", () => {
    const { onClose } = menu({});
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("菜单内的点击不自我关闭", () => {
    const { panel, onClose } = menu({});
    fireEvent.pointerDown(panel as HTMLElement);
    expect(onClose).not.toHaveBeenCalled();
  });

  test("触发器自己的 pointerdown 留给它自己处理（点了不该既开又关）", () => {
    const { trigger, onClose } = menu({});
    fireEvent.pointerDown(trigger);
    expect(onClose).not.toHaveBeenCalled();
  });

  test("关闭后焦点归还触发器", () => {
    const triggerBefore = document.createElement("button");
    document.body.append(triggerBefore);
    triggerBefore.focus();
    const onSelect = vi.fn();
    const view = render(
      <ExportMenu open onSelect={onSelect} onClose={() => undefined} />
    );
    expect(document.activeElement).not.toBe(triggerBefore);
    view.unmount();
    expect(document.activeElement).toBe(triggerBefore);
    triggerBefore.remove();
  });

  test("父组件重渲染不重新抢焦点", () => {
    // 回归用例：`onClose` 是内联箭头时，副作用曾随每次渲染重跑并把焦点拽回菜单。
    const outside = document.createElement("input");
    document.body.append(outside);
    const Harness = ({ onClose }: { onClose: () => void }) => (
      <ExportMenu open onSelect={() => undefined} onClose={onClose} />
    );
    const { rerender } = render(<Harness onClose={() => undefined} />);
    outside.focus();
    rerender(<Harness onClose={() => undefined} />);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
