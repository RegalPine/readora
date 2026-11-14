/**
 * 图片放大查看（Lightbox）（PRD-002 §9.2、IMP-002 TASK-08-02、STORY-08-02）。
 *
 * 覆盖层只吃已经解析好的 webviewUri：它不请求 Host、不拼路径、不猜本地位置，
 * 因此「能放大」与「能加载」是同一个权限结论的两个视图，不存在第二条放行通道。
 *
 * 交互口径：放大 / 缩小 / 适应窗口 / 拖动 / 关闭 + 键盘 Esc、+、-、0。
 * 按产品反馈不再摆「1:1」那枚按钮（窄图上它与 Fit 同义，宽图上又是一个让人
 * 猜该按哪个的第二档），但复位本身还在，只是只走键盘 `0`。
 * 焦点口径：打开时聚焦关闭按钮，Tab 在层内循环（焦点陷阱），
 * 关闭时焦点归还给触发它的元素 —— 键盘用户不该被留在页面顶部。
 */
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { ImageActivationRequest } from "./interactions";

export const LIGHTBOX_ZOOM_IN = 1.25;
export const LIGHTBOX_ZOOM_OUT = 0.8;
export const LIGHTBOX_MIN_SCALE = 0.2;
export const LIGHTBOX_MAX_SCALE = 8;

const FOCUSABLE_SELECTOR = "button, [href], input, [tabindex]:not([tabindex='-1'])";

function clampScale(value: number): number {
  return Math.min(LIGHTBOX_MAX_SCALE, Math.max(LIGHTBOX_MIN_SCALE, value));
}

export interface LightboxProps {
  request: ImageActivationRequest;
  onClose(): void;
}

export function Lightbox({ request, onClose }: LightboxProps) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  // 焦点归还：打开前谁是活动元素，关掉后还给谁。
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      previous?.focus?.();
    };
  }, []);

  const fit = useCallback(() => {
    const viewport = dialogRef.current;
    if (!natural || !viewport) {
      setScale(1);
      setOffset({ x: 0, y: 0 });
      return;
    }
    const available = {
      width: Math.max(1, viewport.clientWidth - 32),
      height: Math.max(1, viewport.clientHeight - 88)
    };
    // 适应窗口只缩不放大：小图被拉糊不如保持原尺寸居中。
    const next = Math.min(1, available.width / natural.width, available.height / natural.height);
    setScale(clampScale(next));
    setOffset({ x: 0, y: 0 });
  }, [natural]);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const zoomBy = useCallback((factor: number) => {
    setScale((current) => clampScale(current * factor));
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(LIGHTBOX_ZOOM_IN);
        return;
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomBy(LIGHTBOX_ZOOM_OUT);
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        reset();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      // 焦点陷阱：Tab 只在层内循环，读屏与键盘用户不会掉到背景正文里。
      const dialog = dialogRef.current;
      if (!dialog) {
        return;
      }
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      const active = document.activeElement;
      /*
       * 焦点可能已经落到层外（打开时点击了背景正文、或浏览器把焦点还给了别处）：
       * 这时 Tab 直接把焦点拉回层内，才算真正的陷阱 —— 否则用户会被留在背景里。
       */
      if (!dialog.contains(active)) {
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
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, reset, zoomBy]);

  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>): void => {
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX: offset.x,
      baseY: offset.y
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLImageElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    setOffset({
      x: drag.baseX + (event.clientX - drag.startX),
      y: drag.baseY + (event.clientY - drag.startY)
    });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLImageElement>): void => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  };

  const transform = useMemo(
    () => `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
    [offset.x, offset.y, scale]
  );

  return (
    <div
      className="readora-lightbox"
      data-readora-lightbox-state="open"
      role="dialog"
      aria-modal="true"
      aria-label={request.alt.length > 0 ? request.alt : "Image viewer"}
      ref={dialogRef}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="readora-lightbox-toolbar" role="toolbar" aria-label="Image controls">
        <button
          type="button"
          className="readora-lightbox-tool"
          data-readora-lightbox-action="zoom-in"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => {
            zoomBy(LIGHTBOX_ZOOM_IN);
          }}
        >
          ＋
        </button>
        <button
          type="button"
          className="readora-lightbox-tool"
          data-readora-lightbox-action="zoom-out"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => {
            zoomBy(LIGHTBOX_ZOOM_OUT);
          }}
        >
          －
        </button>
        <button
          type="button"
          className="readora-lightbox-tool"
          data-readora-lightbox-action="fit"
          aria-label="Fit to window"
          title="Fit to window"
          onClick={fit}
        >
          Fit
        </button>
        <span className="readora-lightbox-scale" aria-live="polite">{`${Math.round(scale * 100)}%`}</span>
        <button
          type="button"
          className="readora-lightbox-tool readora-lightbox-close"
          data-readora-lightbox-action="close"
          aria-label="Close"
          title="Close (Esc)"
          ref={closeRef}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <img
        className="readora-lightbox-image"
        src={request.src}
        alt={request.alt}
        draggable={false}
        style={{ transform }}
        data-readora-lightbox-scale={String(scale)}
        onLoad={(event) => {
          const element = event.currentTarget;
          setNatural({ width: element.naturalWidth, height: element.naturalHeight });
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <p className="readora-lightbox-caption">{request.reference}</p>
    </div>
  );
}
