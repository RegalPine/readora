/**
 * 缩放（PRD-003 §10.5 缩放组、§11.4 偏好单一变量驱动）。
 *
 * 缩放是**会话内状态**，不写 `readora.*` 配置：§11.4 明确它属于「看这一眼时
 * 想凑近点」的一次性动作，与字号偏好不同层级 —— 偏好改的是 16px 这个基准，
 * 缩放改的是当前视图。两者相乘后仍夹在 8–32px（`applyTheme` 负责），于是
 * 「基准 + 缩放」不会把正文推出可读区间，也不会污染用户的配置文件。
 *
 * 键位策略沿用 `useSearchShortcuts`：只在画面有文档时接管 `Ctrl/Cmd + = / - / 0`。
 * 空视图里抢按键会让用户以为扩展卡住了；宿主自己的键位在 Webview 之外，
 * 我们只接管这一层已经收到的事件。
 */
import { useCallback, useEffect, useState } from "react";

/** 区间与步长（PRD-003 §10.5：字号 50%–200%，步长 10%）。 */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.1;
export const ZOOM_RESET = 1;

/**
 * 浮点累加会漂出整步长（`0.6000000000000001 - 0.1` 给的是 0.5000000000000001），
 * 按整百分位量化回去。
 *
 * 网格取 1/100 而不是 `Math.round(v / ZOOM_STEP) * ZOOM_STEP`：后者乘回 0.1 时
 * 仍然带漂移（`12 * 0.1 = 1.2000000000000002`），等于没量化。整百分位既是显示粒度
 * （`formatZoom` 就是取百分数），也严格落进步长 0.1 的格点上，连点十几个来回
 * 后仍是精确的 1.1 / 1.2 / …
 */
function quantize(value: number): number {
  return Math.round(value * 100) / 100;
}

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) {
    return ZOOM_RESET;
  }
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, quantize(value)));
}

/** `delta` 以步长为单位（+1 / -1），越界停在端点上而不是回弹。 */
export function zoomBy(zoom: number, steps: number): number {
  return clampZoom(zoom + steps * ZOOM_STEP);
}

export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

export interface ZoomApi {
  readonly zoom: number;
  readonly display: string;
  readonly canZoomIn: boolean;
  readonly canZoomOut: boolean;
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
}

/**
 * @param enabled 画面有文档才接管按键（见头注）。状态本身始终可读写，
 *                关掉的只是全局键位监听，弹层与顶栏按钮不受影响。
 */
export function useZoom(enabled: boolean): ZoomApi {
  const [zoom, setZoom] = useState(ZOOM_RESET);

  const step = useCallback((steps: number): void => {
    setZoom((current) => clampZoom(current + steps * ZOOM_STEP));
  }, []);
  const reset = useCallback(() => {
    setZoom(ZOOM_RESET);
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.altKey) {
        return;
      }
      const key = event.key;
      if (key === "=" || key === "+") {
        event.preventDefault();
        step(1);
        return;
      }
      if (key === "-" || key === "_") {
        event.preventDefault();
        step(-1);
        return;
      }
      if (key === "0") {
        event.preventDefault();
        reset();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled, step, reset]);

  return {
    zoom,
    display: formatZoom(zoom),
    canZoomIn: zoom < ZOOM_MAX,
    canZoomOut: zoom > ZOOM_MIN,
    zoomIn: () => {
      step(1);
    },
    zoomOut: () => {
      step(-1);
    },
    reset
  };
}
