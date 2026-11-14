/**
 * 宿主主题映射（ARC-006 §6.1 / PRD-003 §13.3）。
 *
 * 两条规则：
 * 1. 宿主的 `--vscode-*` 不直接当阅读器设计 token 用，中间隔一层
 *    `--readora-host-*` 中转名——将来换宿主变量名只改这一处；
 * 2. 每个宿主变量都必须带 fallback，且 fallback 只写语义 token 名、
 *    不写色值：主题没提供 `--vscode-descriptionForeground` 时界面要退回
 *    自己的语义色，而不是整块失色。
 */

import { COLOR_PREFIX, HOST_PREFIX } from "./token-registry";

export interface HostThemeMapping {
  /** 宿主注入的变量（ARC-006 §6.1 左列）。 */
  hostVariable: string;
  /** PRD-003 §13.3 的中转变量名。 */
  relay: string;
  /** 阅读器语义 token（ARC-006 §6.1 右列）。 */
  semanticToken: string;
  /** 语义 token 短名，便于测试按名查表。 */
  name: string;
}

/**
 * 宿主名 → 中转变量名：`sideBar.background` → `--readora-host-side-bar-background`。
 * 点号和驼峰都要换成连字符，PRD-003 §13.1 的 `--readora-{category}-{name}`
 * 只允许小写字母与数字，照抄 `sideBar` 会造出一个不合名字规则的 token。
 */
function relayName(host: string): string {
  return host
    .replace(/\./gu, "-")
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase();
}

function mapping(host: string, name: string): HostThemeMapping {
  return {
    hostVariable: `--vscode-${host}`,
    relay: `${HOST_PREFIX}${relayName(host)}`,
    semanticToken: `${COLOR_PREFIX}${name}`,
    name
  };
}

/** ARC-006 §6.1 的九条映射，顺序即 `tokens.css` 中的书写顺序。 */
export const HOST_THEME_MAP: readonly HostThemeMapping[] = [
  mapping("editor.background", "canvas"),
  mapping("editor.foreground", "text-primary"),
  mapping("panel.background", "surface"),
  mapping("panel.border", "border"),
  mapping("sideBar.background", "surface-subtle"),
  mapping("descriptionForeground", "text-secondary"),
  mapping("focusBorder", "focus"),
  mapping("textLink.foreground", "link"),
  mapping("errorForeground", "danger")
];

export const HOST_RELAY_TOKEN_NAMES: readonly string[] = HOST_THEME_MAP.map(
  (entry) => entry.relay
);

/** 宿主映射覆盖到的语义 token 名（其余 token 在 vscode 模式下沿用亮/暗板）。 */
export const HOST_MAPPED_SEMANTIC_NAMES: readonly string[] = HOST_THEME_MAP.map(
  (entry) => entry.name
);

/**
 * 一条 `--readora-host-*: var(--vscode-*, var(--readora-color-*))` 声明。
 *
 * 第三参 `fallbackToken` 用于明暗两套底色：宿主变量缺失时，vscode 暗色块
 * 要退回暗色板而不是亮色板，否则切到暗色宿主主题会闪一块亮色。
 */
export function hostDeclaration(entry: HostThemeMapping, fallbackToken?: string): string {
  const fallback = fallbackToken ?? entry.semanticToken;
  return `${entry.relay}: var(${entry.hostVariable}, var(${fallback}));`;
}
