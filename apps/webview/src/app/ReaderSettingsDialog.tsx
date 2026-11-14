/**
 * Reader Settings 弹层（PRD-003 §4.6 / §10.5，F08-010）。
 *
 * 七项开关全部落在 `readora.*` 配置上，改动即发 `config.patch`（§1 补设的
 * view→host 通道），Host 校验回写后广播 `config.update`，弹层显示的始终是
 * **Host 确认过的值**，不是本地乐观值 —— 非法值被 Host 挡掉时界面不会自己先跳。
 *
 * §4.6 的诚实性同样约束开关：这里**不提供**「代码行号 / 平滑滚动」，也没有
 * 「公式渲染」开关 —— 前两项按 §4.6 点名剔除，第三项随 KaTeX 落地后仍没有
 * 逐项关闭的实现语义（要么渲染要么不渲染，不是一个可以就地切的样式开关）。
 * 缩放也不在这张卡里：§11.4 把它定为会话内状态，写进配置就成了第二份真相。
 *
 * 焦点契约三条：
 * 1. 打开时焦点收拢进弹层，`aria-modal` + Tab 环（弹层外的内容不可 Tab 到）；
 * 2. `Escape` 关闭；
 * 3. 关闭后焦点归位触发器 —— 实现是「挂载时记住 `document.activeElement`，
 *    卸载时还回去」，因此不依赖父子之间再传一个 ref。
 */
import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from "react";
import {
  CONTENT_WIDTH_MAX,
  CONTENT_WIDTH_MIN,
  READER_TYPOGRAPHIES,
  THEME_MODES,
  THEME_PRESETS,
  type ConfigPatchKey,
  type ReaderPreferences,
  type ReaderTypography,
  type ThemeMode,
  type ThemePreset
} from "@readora/contracts";
import { FONT_SIZE_MAX, FONT_SIZE_MIN, LINE_HEIGHT_MAX, LINE_HEIGHT_MIN } from "./theme";
import {
  AutoIcon,
  CheckIcon,
  CloseIcon,
  CodeIcon,
  ContrastIcon,
  SettingsIcon,
  TypefaceIcon
} from "./Icon";

export const SETTINGS_DIALOG_CLASS = "readora-settings-dialog";

/** 枚举项的显示文案与图标：图标只是标识，可读名称永远是文本。 */
const THEME_MODE_LABEL: Record<ThemeMode, string> = {
  auto: "Auto",
  light: "Light",
  dark: "Dark",
  vscode: "VS Code",
  system: "System"
};
const TYPOGRAPHY_LABEL: Record<ReaderTypography, string> = {
  newsreader: "Newsreader",
  geist: "Geist",
  inter: "Inter"
};
const PRESET_LABEL: Record<ThemePreset, string> = {
  default: "Default",
  "high-contrast": "High contrast"
};

export interface ReaderSettingsDialogProps {
  preferences: ReaderPreferences;
  /** 发送 `config.patch`：值域校验与配置写回都在 Host，这里只表达意图。 */
  onPatch(key: ConfigPatchKey, value: number | boolean | string): void;
  onClose(): void;
}

export function ReaderSettingsDialog({
  preferences,
  onPatch,
  onClose
}: ReaderSettingsDialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<Element | null>(null);

  // 打开时记下触发器（此刻它是 activeElement），关闭卸载时还回去。
  useEffect(() => {
    restoreRef.current = document.activeElement;
    // 焦点收拢进弹层：容器自身 tabIndex=-1 可聚焦，第一次 Tab 因此从第一项控件开始。
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
        event.stopPropagation();
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
      // 焦点还在面板外（刚挂载时是面板自身）：先收进来，不让 Tab 第一次就跳出去。
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
        className={SETTINGS_DIALOG_CLASS}
        role="dialog"
        aria-modal="true"
        aria-labelledby="readora-settings-title"
        tabIndex={-1}
        onClick={(event) => {
          // 面板内的点击不该冒泡到 backdrop 把自己关掉。
          event.stopPropagation();
        }}
        onKeyDown={onKeyDown}
      >
        <header className="readora-settings-header">
          <SettingsIcon size={14} />
          <h2 id="readora-settings-title" className="readora-settings-title">
            Reader settings
          </h2>
          <button
            type="button"
            className="readora-settings-close"
            aria-label="Close settings"
            onClick={onClose}
          >
            <CloseIcon size={14} />
          </button>
        </header>

        <Field label="Theme mode">
          <ChoiceGroup
            label="Theme mode"
            options={THEME_MODES}
            labels={THEME_MODE_LABEL}
            value={preferences.theme}
            onSelect={(value) => {
              onPatch("theme", value);
            }}
          />
        </Field>

        <Field label="Preset">
          <ChoiceGroup
            label="Preset"
            options={THEME_PRESETS}
            labels={PRESET_LABEL}
            value={preferences.themePreset}
            icons={{ "high-contrast": <ContrastIcon size={12} /> }}
            onSelect={(value) => {
              onPatch("themePreset", value);
            }}
          />
        </Field>

        <Field label="Typeface">
          <ChoiceGroup
            label="Typeface"
            options={READER_TYPOGRAPHIES}
            labels={TYPOGRAPHY_LABEL}
            value={preferences.typography}
            icons={{ newsreader: <TypefaceIcon size={12} />, geist: <CodeIcon size={12} /> }}
            onSelect={(value) => {
              onPatch("typography", value);
            }}
          />
        </Field>

        <SliderField
          label="Font size"
          hint="Scaled by the zoom control in the top bar; the effective size stays within 8–32 px."
          value={preferences.fontSize}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          step={1}
          unit="px"
          onChange={(value) => {
            onPatch("fontSize", value);
          }}
        />
        <SliderField
          label="Line height"
          value={preferences.lineHeight}
          min={LINE_HEIGHT_MIN}
          max={LINE_HEIGHT_MAX}
          step={0.05}
          onChange={(value) => {
            onPatch("lineHeight", value);
          }}
        />
        <SliderField
          label="Content width"
          value={preferences.contentWidth}
          min={CONTENT_WIDTH_MIN}
          max={CONTENT_WIDTH_MAX}
          step={20}
          unit="px"
          onChange={(value) => {
            onPatch("contentWidth", value);
          }}
        />

        <Field label="Outline">
          <label className="readora-settings-check">
            <input
              type="checkbox"
              checked={preferences.showOutline}
              onChange={(event) => {
                onPatch("showOutline", event.target.checked);
              }}
            />
            <span>Show outline when a reader opens</span>
          </label>
        </Field>

        <p className="readora-settings-note">
          <AutoIcon size={12} />
          Changes are written to <code>readora.*</code> settings and apply to every reader
          window. Zoom and focus mode stay per-session.
        </p>
      </div>
    </div>
  );
}

/**
 * 面板内可聚焦元素：`disabled` 的与负 tabindex 都跳过，Tab 环不能停在按不动的控件上。
 * 弹层里没有隐藏控件，所以不再叠加可见性判断 —— 恒真的条件只是假装有闸。
 */
export function focusableWithin(panel: HTMLElement): HTMLElement[] {
  const selector =
    "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";
  return [...panel.querySelectorAll<HTMLElement>(selector)];
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="readora-settings-field">
      <span className="readora-settings-label">{label}</span>
      {children}
    </div>
  );
}

interface ChoiceGroupProps<T extends string> {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  icons?: Partial<Record<T, ReactNode>>;
  onSelect(value: T): void;
}

/**
 * 枚举项用 `role="group"` + `aria-pressed` 的按钮，而不是 `role="radio"`：
 * radiogroup 的键盘语义要求方向键切换与单个 tab 停驻，这里没实现那套就标成
 * radio，等于给读屏器承诺了做不到的交互。
 */
function ChoiceGroup<T extends string>({
  label,
  options,
  labels,
  value,
  icons = {},
  onSelect
}: ChoiceGroupProps<T>) {
  return (
    <div className="readora-settings-choices" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className="readora-settings-choice"
          aria-pressed={option === value}
          onClick={() => {
            onSelect(option);
          }}
        >
          {icons[option] ?? null}
          {labels[option]}
          {option === value ? <CheckIcon size={12} /> : null}
        </button>
      ))}
    </div>
  );
}

interface SliderFieldProps {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange(value: number): void;
}

/**
 * range 的 value 是字符串，解析单独抽出来做纯函数。
 *
 * `Number("")` 是 0、`Number("  ")` 也是 0 —— 一个被清空的输入框不该发出一条
 * 「把字号设成 0」的补丁。但浏览器（jsdom 同样如此）会先把 range 上的非法值
 * 净化成区间内的默认值，所以「清空滑杆」这种事件在真实 DOM 里造不出来：把守卫
 * 写成 DOM 用例只会得到一条假装验过的断言，于是把可 hostile 的入口收进这个函数，
 * 逐条值直接取证。落进 min/max 由原生 range 兜第一道，Host 复判兜第二道。
 */
export function parseSliderValue(raw: string | null | undefined): number | null {
  const text = (raw ?? "").trim();
  if (text.length === 0) {
    return null;
  }
  const next = Number(text);
  return Number.isFinite(next) ? next : null;
}

function SliderField({ label, hint, value, min, max, step, unit, onChange }: SliderFieldProps) {
  const id = `readora-settings-${label.toLowerCase().replace(/ /gu, "-")}`;
  return (
    <div className="readora-settings-field">
      <label className="readora-settings-label" htmlFor={id}>
        {label}
        <span className="readora-settings-value">
          {value}
          {unit ?? ""}
        </span>
      </label>
      <input
        id={id}
        className="readora-settings-slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          const next = parseSliderValue(event.target.value);
          if (next !== null) {
            onChange(next);
          }
        }}
      />
      {hint ? <p className="readora-settings-hint">{hint}</p> : null}
    </div>
  );
}
