/**
 * 内联 SVG 图标集（PRD-003 §10.6）。
 *
 * 统一 24 viewBox、`stroke="currentColor"`、`stroke-width: 1.5`、`aria-hidden="true"`：
 * 图标只是控件的装饰，可读名称由宿主按钮自己的 `aria-label` 承担 —— 两处都给，
 * 读屏器会把「Toggle outline」念成「Toggle outline, outline」。
 *
 * 不引入图标字体（§10.6 的取舍）：Material Symbols 全量 woff2 是 MB 级，还要给
 * 构建链加 fonttools 子集化这一原生工具依赖；codicons 的字形与原型不符。内联
 * 组件的代价只是几百行 JSX，且随 tree-shaking 只打包真正用到的那几个。
 *
 * 尺寸是入参而不是写死：顶栏 44px、状态条 24px、弹层行高各不相同，24px 图标塞进
 * 状态条会把整条顶高。描边宽度不跟着尺寸缩 —— 缩到 1px 在暗色底上会断。
 */
import type { ReactNode } from "react";

export const ICON_CLASS = "readora-icon";
export const ICON_VIEWBOX = "0 0 24 24";
/** 与 PRD-003 §10.6 逐字一致，不可随手调粗。 */
export const ICON_STROKE_WIDTH = 1.5;
/** 顶栏基准边长：再大就要顶开 44px 这一行的其它内容。 */
export const ICON_SIZE = 16;

export interface IconProps {
  size?: number;
  className?: string;
}

interface IconShapeProps extends IconProps {
  children: ReactNode;
}

function Icon({ size = ICON_SIZE, className, children }: IconShapeProps) {
  return (
    <svg
      className={className ? `${ICON_CLASS} ${className}` : ICON_CLASS}
      width={size}
      height={size}
      viewBox={ICON_VIEWBOX}
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE_WIDTH}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** 导出：从托盘里向上离开的箭头，方向感与「下载/打开」的箭头相反。 */
export function ExportIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3v10" />
      <path d="M8 7l4-4 4 4" />
      <path d="M4 15v4h16v-4" />
    </Icon>
  );
}

/** 大纲：三条右对齐的横线 + 项目点，层级感来自缩进而非颜色。 */
export function OutlineIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
    </Icon>
  );
}

/** 专注模式：外框收拢、中心一块正文。 */
export function FocusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
      <path d="M9 12h6" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="M15 15l4.5 4.5" />
    </Icon>
  );
}

/** Reader Settings：三档滑杆。弹层触发器的图标，不是路由入口。 */
export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="15" cy="17" r="2" />
    </Icon>
  );
}

export function MinusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12h14" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
    </Icon>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
    </Icon>
  );
}

/** 高对比预设：一半实心一半空心的圆。 */
export function ContrastIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4v16a8 8 0 0 0 0-16z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** 自动 / 跟随系统：外圈 + 指针。 */
export function AutoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M14.5 9.5l-4 1.5-1.5 4 4-1.5z" />
    </Icon>
  );
}

/** 代码面板（宿主模式）：尖括号。 */
export function CodeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 8l-4 4 4 4M15 8l4 4-4 4" />
    </Icon>
  );
}

/** 字族：一个大写 A，横杠位置暗示衬线。 */
export function TypefaceIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 19l6-14h2l6 14M8 14h8" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 9.5l6 6 6-6" />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.5 6l6 6-6 6" />
    </Icon>
  );
}

/** 展开全部 / 收起全部：双向箭头。 */
export function ExpandIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 10l4-4 4 4M8 14l4 4 4-4" />
    </Icon>
  );
}

/** 过滤：漏斗。大纲面板头部用它标注过滤输入框。 */
export function FilterIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 5h16l-6 7v7l-4-2v-5z" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Icon>
  );
}
