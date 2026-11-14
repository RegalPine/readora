/**
 * 主题 Context（ARC-006 §10.1）。
 *
 * 只读：本层把 Host 解析出的主题状态交给**确实需要主题元数据**的消费者
 * ——图表适配器一类要按明暗挑系列色的地方，以及状态条一类要显示当前主题的
 * 地方。普通组件不走这里：颜色一律由 CSS Variables 承担（§10.2），
 * 为了让配色变化而触发 React 重渲染是把主题态拿去做反模式。
 *
 * 不提供 `setMode`：Webview 没有写回 Host 的通道（ARC-004 §8.3 只有 Host→View
 * 的 `theme.update`），给了就是个按不动的假开关。登记为待办见 README。
 */
import { createContext, useContext, type ReactNode } from "react";
import type { ReaderPreferences, ResolvedTheme, ThemeSource } from "@readora/contracts";

export interface ThemeContextValue {
  /** 解析后的明暗（scheme 轴）：代码配色与图表系列色跟它走。 */
  theme: ResolvedTheme;
  /** 取色来源（palette 轴由它与 theme 一起派生，vscode 时取宿主变量）。 */
  source: ThemeSource;
  /** 生效的阅读偏好；Host 未下发前为 null，此时 tokens.css 的默认值即真相。 */
  preferences: ReaderPreferences | null;
}

/**
 * 无 Provider 时的兜底，与首帧预置之前的状态一致：产品亮色 + 偏好缺省。
 * 组件在孤立的单测里渲染因此不需要套一层 Provider。
 */
export const DEFAULT_THEME_CONTEXT: ThemeContextValue = {
  theme: "light",
  source: "product",
  preferences: null
};

const ThemeContext = createContext<ThemeContextValue>(DEFAULT_THEME_CONTEXT);

export interface ThemeProviderProps {
  value: ThemeContextValue;
  children?: ReactNode;
}

/** 值由 App 单点持有并整体下发：这里不做二次状态，避免两处主题态各自演化。 */
export function ThemeProvider({ value, children }: ThemeProviderProps) {
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** 读取当前主题状态（只读，无写入通道）。 */
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
