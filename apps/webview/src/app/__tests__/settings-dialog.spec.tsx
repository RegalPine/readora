/**
 * Reader Settings 弹层的键盘与焦点契约（PRD-003 §4.6 / §10.5，F08-010）。
 *
 * App 侧的接线（config.patch 往返、aria-expanded）在 `app-navigation.spec.tsx`，
 * 这里只管弹层自己承诺的三件事：
 * 1. 焦点收拢在弹层内并成环（`aria-modal` 不是装饰，Tab 不能漏到背景里）；
 * 2. `Escape` 关闭且事件不外溢（宿主的「退出专注」等键位不该被同一次按键连带触发）；
 * 3. 只给做得到开关：§4.6 点名的「代码行号 / 平滑滚动」以及没有实现语义的
 *    「公式渲染」开关都不许出现在这张卡上。
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReaderPreferences } from "@readora/contracts";
import { CONTENT_WIDTH_MAX, CONTENT_WIDTH_MIN } from "@readora/contracts";
import { ReaderSettingsDialog, SETTINGS_DIALOG_CLASS, parseSliderValue } from "../ReaderSettingsDialog";
import { FONT_SIZE_MAX, FONT_SIZE_MIN, LINE_HEIGHT_MAX, LINE_HEIGHT_MIN } from "../theme";

const PREFERENCES: ReaderPreferences = {
  theme: "auto",
  fontSize: 17,
  lineHeight: 1.8,
  contentWidth: 720,
  showOutline: true,
  typography: "newsreader",
  themePreset: "default"
};

afterEach(cleanup);

function dialog(overrides: Partial<ReaderPreferences> = {}) {
  const onPatch = vi.fn();
  const onClose = vi.fn();
  // 触发器：真实场景里它是顶栏那枚按钮，弹层要在卸载时把焦点还给它。
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.textContent = "trigger";
  document.body.append(trigger);
  trigger.focus();

  const view = render(
    <ReaderSettingsDialog
      preferences={{ ...PREFERENCES, ...overrides }}
      onPatch={onPatch}
      onClose={onClose}
    />
  );
  return { view, onPatch, onClose, trigger };
}

function panel(view: ReturnType<typeof dialog>["view"]): HTMLElement {
  const node = view.container.querySelector<HTMLElement>(`.${SETTINGS_DIALOG_CLASS}`);
  if (!node) {
    throw new Error("settings dialog not rendered");
  }
  return node;
}

describe("七个字段的取值与文案", () => {
  test("每项都反映 Host 确认过的当前值", () => {
    const { view } = dialog();
    const pressed = (name: string): string | null =>
      view.getByRole("button", { name }).getAttribute("aria-pressed");
    expect(pressed("Auto")).toBe("true");
    expect(pressed("Light")).toBe("false");
    expect(pressed("Default")).toBe("true");
    expect(pressed("High contrast")).toBe("false");
    expect(pressed("Newsreader")).toBe("true");
    expect(pressed("Geist")).toBe("false");
    expect(pressed("Inter")).toBe("false");
    expect((view.getByLabelText(/^Font size/) as HTMLInputElement).value).toBe("17");
    expect((view.getByLabelText(/^Line height/) as HTMLInputElement).value).toBe("1.8");
    expect((view.getByLabelText(/^Content width/) as HTMLInputElement).value).toBe("720");
    expect((view.getByLabelText(/Show outline/) as HTMLInputElement).checked).toBe(true);
  });

  test("滑杆区间与偏好契约同边界：字号 8–32、行高 1–3、宽度 480–1200", () => {
    const { view } = dialog();
    const size = view.getByLabelText(/^Font size/) as HTMLInputElement;
    expect([Number(size.min), Number(size.max)]).toEqual([FONT_SIZE_MIN, FONT_SIZE_MAX]);
    const height = view.getByLabelText(/^Line height/) as HTMLInputElement;
    expect([Number(height.min), Number(height.max)]).toEqual([LINE_HEIGHT_MIN, LINE_HEIGHT_MAX]);
    const width = view.getByLabelText(/^Content width/) as HTMLInputElement;
    expect([Number(width.min), Number(width.max)]).toEqual([CONTENT_WIDTH_MIN, CONTENT_WIDTH_MAX]);
  });

  test("§4.6 的剔除项一个都不许出现（含没有实现语义的「公式渲染」开关）", () => {
    const { view } = dialog();
    const text = panel(view).textContent ?? "";
    for (const forbidden of [/line number/iu, /smooth scroll/iu, /公式/iu, /math/iu]) {
      expect(text).not.toMatch(forbidden);
    }
    // 缩放是会话内状态（§11.4），不在这张写配置的卡里：三个滑杆正好是三项偏好。
    expect(view.container.querySelectorAll('input[type="range"]')).toHaveLength(3);
  });

  test("改动即发 config.patch：枚举发字符串、滑杆发数字、开关发布尔", () => {
    const { view, onPatch } = dialog();
    fireEvent.click(view.getByRole("button", { name: "Dark" }));
    fireEvent.click(view.getByRole("button", { name: "High contrast" }));
    fireEvent.click(view.getByRole("button", { name: "Geist" }));
    fireEvent.change(view.getByLabelText(/^Line height/) as HTMLElement, { target: { value: "2" } });
    fireEvent.click(view.getByLabelText(/Show outline/) as HTMLElement);
    expect(onPatch.mock.calls).toEqual([
      ["theme", "dark"],
      ["themePreset", "high-contrast"],
      ["typography", "geist"],
      ["lineHeight", 2],
      ["showOutline", false]
    ]);
  });

  test("预设与字族的枚举项用 aria-pressed 而不是假的 radiogroup", () => {
    const { view } = dialog();
    expect(view.queryByRole("radiogroup")).toBeNull();
    expect(view.queryAllByRole("radio")).toHaveLength(0);
    const group = view.getByRole("group", { name: "Preset" });
    expect(group.getAttribute("aria-label")).toBe("Preset");
    // 选中项额外带一枚勾选图标，可读名称仍是文本（图标不单独承载信息）。
    expect(group.querySelector('[aria-pressed="true"] svg')).not.toBeNull();
  });
});

describe("焦点与按键契约", () => {
  test("挂载即把焦点收进弹层，卸载时还给触发器", () => {
    const { view, trigger } = dialog();
    expect(panel(view).contains(document.activeElement)).toBe(true);
    cleanup();
    expect(document.activeElement).toBe(trigger);
  });

  test("Tab 在弹层内成环：末位下去回首位，首位上来回末位", () => {
    const { view } = dialog();
    const root = panel(view);
    const items = [...root.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled])"
    )];
    expect(items.length).toBeGreaterThan(3);
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;

    last.focus();
    fireEvent.keyDown(root, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(root, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  test("焦点还在弹层外时第一次 Tab 也不漏出去", () => {
    const { view, trigger } = dialog();
    trigger.focus();
    fireEvent.keyDown(panel(view), { key: "Tab" });
    expect(panel(view).contains(document.activeElement)).toBe(true);
  });

  test("Escape 关闭并阻止外溢；关闭按钮与 backdrop 同样生效", () => {
    const { view, onClose } = dialog();
    fireEvent.keyDown(panel(view), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(view.getByRole("button", { name: "Close settings" }));
    expect(onClose).toHaveBeenCalledTimes(2);

    // 面板内的点击不该冒泡到 backdrop 把自己关掉。
    fireEvent.click(panel(view));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(view.container.querySelector(".readora-settings-backdrop") as Element);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  test("其他按键不误关", () => {
    const { view, onClose } = dialog();
    fireEvent.keyDown(panel(view), { key: "Enter" });
    fireEvent.keyDown(panel(view), { key: "Tab" });
    fireEvent.keyDown(panel(view), { key: "Backspace" });
    expect(onClose).not.toHaveBeenCalled();
  });

  test("弹层可聚焦容器带 aria-labelledby 指向标题", () => {
    const { view } = dialog();
    const root = panel(view);
    expect(root.getAttribute("tabindex")).toBe("-1");
    expect(root.getAttribute("aria-modal")).toBe("true");
    const labelledBy = root.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(view.container.querySelector(`#${labelledBy}`)?.textContent).toBe("Reader settings");
  });
});

describe("滑杆的数值出口", () => {
  test("空串、空白、非数字都不给值：`Number(\"\")` 是 0，清空不等于「把字号设成 0」", () => {
    expect(parseSliderValue("")).toBeNull();
    expect(parseSliderValue("   ")).toBeNull();
    expect(parseSliderValue("abc")).toBeNull();
    expect(parseSliderValue("NaN")).toBeNull();
    expect(parseSliderValue("Infinity")).toBeNull();
    expect(parseSliderValue(null)).toBeNull();
    expect(parseSliderValue(undefined)).toBeNull();
  });

  test("数字照收，区间判定留给 Host 复判", () => {
    expect(parseSliderValue("20")).toBe(20);
    expect(parseSliderValue(" 1.85 ")).toBe(1.85);
    expect(parseSliderValue("0")).toBe(0);
    expect(parseSliderValue("-3")).toBe(-3);
  });

  test("range 上送不出非数字：浏览器先把非法值净化成区间内默认值", () => {
    const { view, onPatch } = dialog();
    // 这条记录的是「事件那条路走不到 hostile 输入」，因此上面的解析要按纯函数取证：
    // 只留这一道 DOM 闸就等于信任浏览器做唯一的守卫。
    fireEvent.change(view.getByLabelText(/^Font size/) as HTMLElement, { target: { value: "" } });
    expect(onPatch).toHaveBeenCalledWith("fontSize", 20);
  });

  test("合法值按数字发出", () => {
    const { view, onPatch } = dialog();
    fireEvent.change(view.getByLabelText(/^Content width/) as HTMLElement, { target: { value: "900" } });
    expect(onPatch).toHaveBeenCalledWith("contentWidth", 900);
  });
});

afterEach(() => {
  act(() => {
    document.body.replaceChildren();
  });
});
