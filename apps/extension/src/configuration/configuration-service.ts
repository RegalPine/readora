/**
 * 配置服务（ARC-004 §11）：读取 readora.* 配置并解析主题。
 *
 * 主题模式（ARC-006 §5.1）由 Host 归一成「明暗 + 来源」两轴，
 * Webview 只接收解析结果：auto / system / vscode 都不会原样出现在
 * theme.update 载荷里（契约见 contracts ThemeUpdatePayloadSchema）。
 */
import * as vscode from "vscode";
import {
  CONTENT_WIDTH_MAX,
  CONTENT_WIDTH_MIN,
  DEFAULT_CONTENT_WIDTH,
  DEFAULT_FONT_SIZE,
  DEFAULT_LINE_HEIGHT,
  DEFAULT_SHOW_OUTLINE,
  DEFAULT_THEME_MODE,
  DEFAULT_THEME_PRESET,
  DEFAULT_TYPOGRAPHY,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  isReaderTypography,
  isThemeMode,
  isThemePreset,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  ReaderPreferencesSchema,
  READORA_ERROR_CODES,
  type ConfigPatchKey,
  type ReaderPreferences,
  type ResolvedTheme,
  type ThemeMode,
  type ThemeState
} from "@readora/contracts";
import { DEFAULT_CUSTOM_CSS_MAX_CHARS } from "@readora/design-tokens";
import { CONFIG_SECTION } from "../constants";
import { ReaderError } from "../errors";
import {
  createResourcePolicy,
  DEFAULT_MAX_IMAGE_MB,
  MAX_IMAGE_MB_RANGE,
  type ResourcePolicy
} from "../resources/resource-policy";

/**
 * 自定义 CSS 的长度上限。
 *
 * 唯一权威是净化器（`DEFAULT_CUSTOM_CSS_MAX_CHARS`），这里只是转发一个别名给
 * 装配层与 manifest.spec 断言之用 —— manifest 的 `maxLength` 必须与之相等，
 * 否则会出现「编辑器允许输入、净化器一定拒绝」的死区。
 */
export const CUSTOM_CSS_MAX_LENGTH = DEFAULT_CUSTOM_CSS_MAX_CHARS;

/**
 * 偏好键 → 配置键。
 *
 * `themePreset` 必须落扁平的 `readora.themePreset`，不能写成 `readora.theme.preset`：
 * 宿主把 settings.json 的点号键展开成一棵树（取证于 workbench 产物里那段
 * 「split(".") 逐段下降、遇非对象即 `Ignoring <key> as <前缀> is <值>` 并整条丢弃」
 * 的装配逻辑）。`readora.theme` 本身是字符串叶，于是 `readora.theme.preset` 这条
 * 子键永远被丢掉 —— 写盘照样落进 settings.json，读回来却只有 undefined，
 * 表现为「点 High contrast 没反应」。命名空间的层级只能用在没有同名字段的
 * 前缀上（`readora.resources.*` / `readora.export.*` 都成立，因此保留）。
 */
const CONFIG_KEY_BY_PREFERENCE: Record<ConfigPatchKey, string> = {
  theme: "theme",
  fontSize: "fontSize",
  lineHeight: "lineHeight",
  contentWidth: "contentWidth",
  showOutline: "showOutline",
  typography: "typography",
  themePreset: "themePreset"
};

function readTheme(config: vscode.WorkspaceConfiguration): ThemeMode {
  const raw = config.get("theme");
  // 非法值回退默认：配置写错不该让阅读器变成半主题状态（ARC-006 §8.2 安全默认值）。
  return isThemeMode(raw) ? raw : DEFAULT_THEME_MODE;
}

/** 宿主当前明暗。高对比（无 light 后缀）按暗色处理，边界交由 forced-colors 分支。 */
function hostScheme(): ResolvedTheme {
  const kind = vscode.window.activeColorTheme.kind;
  return kind === vscode.ColorThemeKind.Light ||
    kind === vscode.ColorThemeKind.HighContrastLight
    ? "light"
    : "dark";
}

function readBoolean(config: vscode.WorkspaceConfiguration, key: string, fallback: boolean): boolean {
  const raw = config.get(key);
  return typeof raw === "boolean" ? raw : fallback;
}

function readNumber(
  config: vscode.WorkspaceConfiguration,
  key: string,
  min: number,
  max: number,
  fallback: number
): number {
  const raw = config.get(key);
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, raw));
}

export class ConfigurationService implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this.changeEmitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor() {
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration(CONFIG_SECTION) ||
          event.affectsConfiguration("workbench.colorTheme")
        ) {
          this.changeEmitter.fire();
        }
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.changeEmitter.fire();
      })
    );
  }

  /** 读取当前偏好；越界/非法值回退到默认，保证 payload 永远通过 Schema。 */
  getPreferences(): ReaderPreferences {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const showOutline = config.get("showOutline");
    const typography = config.get("typography");
    const themePreset = config.get("themePreset");
    return {
      theme: readTheme(config),
      fontSize: readNumber(config, "fontSize", FONT_SIZE_MIN, FONT_SIZE_MAX, DEFAULT_FONT_SIZE),
      lineHeight: readNumber(config, "lineHeight", LINE_HEIGHT_MIN, LINE_HEIGHT_MAX, DEFAULT_LINE_HEIGHT),
      contentWidth: readNumber(
        config,
        "contentWidth",
        CONTENT_WIDTH_MIN,
        CONTENT_WIDTH_MAX,
        DEFAULT_CONTENT_WIDTH
      ),
      showOutline: typeof showOutline === "boolean" ? showOutline : DEFAULT_SHOW_OUTLINE,
      // 枚举值不做「就近匹配」：写错一个字就回默认字族，比让正文突然换栈更好解释。
      typography: isReaderTypography(typography) ? typography : DEFAULT_TYPOGRAPHY,
      themePreset: isThemePreset(themePreset) ? themePreset : DEFAULT_THEME_PRESET
    };
  }

  /**
   * 自定义 CSS 原文（F08-011）。
   *
   * 这里只负责「读出来」，净化与注入策略在 `@readora/design-tokens` 的
   * `sanitizeCustomCss()`：配置项属于不可信输入（工作区可自带 settings.json），
   * 不得在读取点就当成样式文本用。长度超限同样**不截断**——截断后再净化会把
   * 「你的 CSS 太长被拒了」伪装成「你的 CSS 生效了一部分」，是更难排查的那类错误。
   */
  getCustomCss(): string {
    const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get("customCss");
    return typeof raw === "string" ? raw : "";
  }

  /**
   * 写回单项偏好（config.patch 的唯一落点）。
   *
   * 校验顺序是刻意的：先与当前偏好合并、整体过 `ReaderPreferencesSchema`，
   * 再写配置。于是区间/枚举的唯一权威仍是那张 Schema（这里不复制第二套边界），
   * 而非法值会被拒绝而不是被静默夹到边界值 —— 后者会让弹层显示 32px
   * 而用户点的是「+」到 40px，属于可感知的说谎。
   */
  async patchPreference(
    key: ConfigPatchKey,
    value: unknown
  ): Promise<ReaderPreferences> {
    const candidate = { ...this.getPreferences(), [key]: value };
    const parsed = ReaderPreferencesSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ReaderError(
        READORA_ERROR_CODES.INVALID_PAYLOAD,
        `Rejected config.patch for readora.${CONFIG_KEY_BY_PREFERENCE[key]}: ${parsed.error.issues
          .map((issue) => issue.message)
          .join("; ")}`
      );
    }
    await vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .update(
        CONFIG_KEY_BY_PREFERENCE[key],
        parsed.data[key],
        vscode.ConfigurationTarget.Global
      );
    return parsed.data;
  }

  /**
   * 本机浏览器路径（M11 · `readora.export.chromePath`）。
   *
   * 只服务 PDF / PNG：HTML 通道不碰 Chrome。留空是合法取值 —— 那意味着
   * 「按探测顺序自己找」，所以这里不做任何存在性校验，也不把非字符串当错误：
   * settings.json 属于不可信输入，读出一句「没配好」式的默认值比抛异常更合适。
   */
  getExportChromePath(): string {
    const raw = vscode.workspace.getConfiguration(CONFIG_SECTION).get("export.chromePath");
    return typeof raw === "string" ? raw.trim() : "";
  }

  /**
   * 资源策略（ARC-008 §6.2）：只读 readora.resources.* 两个已声明的配置项，
   * 其余维度取安全默认值（工作区内本地资源放行、外部与 data: 关闭）。
   */
  getResourcePolicy(): ResourcePolicy {
    const resources = vscode.workspace.getConfiguration(`${CONFIG_SECTION}.resources`);
    return createResourcePolicy({
      allowExternalImages: readBoolean(resources, "allowExternalImages", false),
      maxImageSizeMb: readNumber(
        resources,
        "maxImageSizeMb",
        MAX_IMAGE_MB_RANGE.min,
        MAX_IMAGE_MB_RANGE.max,
        DEFAULT_MAX_IMAGE_MB
      )
    });
  }

  /**
   * 归一主题（ARC-006 §7.2 解析流程）：相同输入必须产生相同结果。
   *
   * product（light / dark）与宿主明暗无关；vscode 与 system / auto 都从
   * `activeColorTheme.kind` 取明暗，区别只在 Webview 侧走哪一层取色：
   * vscode 让语义 Token 映射宿主 `--vscode-*`，system 挑产品调色板。
   * 高对比主题按暗色处理，其边界与焦点由 `forced-colors` 分支负责。
   */
  resolveTheme(preferences?: ReaderPreferences): ThemeState {
    const mode = (preferences ?? this.getPreferences()).theme;
    if (mode === "light" || mode === "dark") {
      return { mode, source: "product" };
    }
    return {
      mode: hostScheme(),
      source: mode === "vscode" ? "vscode" : "system"
    };
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
    this.changeEmitter.dispose();
  }
}