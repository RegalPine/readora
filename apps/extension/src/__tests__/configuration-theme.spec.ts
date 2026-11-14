/**
 * 主题归一测试（ARC-006 §5.1 四模式、§7.2 解析流程、§8.2 安全默认值）。
 *
 * 断言的是确定性：相同（模式, 宿主 kind）输入必须产生相同的「明暗 + 来源」，
 * 以及三个易错点——product 不受宿主影响、auto 与 system 同义、
 * 非法配置值不得让界面停在半主题状态。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("vscode", async () => await import("../__stubs__/vscode"));

import type { ReaderPreferences, ThemeMode } from "@readora/contracts";
import { ConfigurationService } from "../configuration/configuration-service";
import {
  ColorThemeKind,
  configValues,
  ignoredConfigKeys,
  resetVscodeStub,
  window,
  workspace
} from "../__stubs__/vscode";

function prefs(theme: ThemeMode): ReaderPreferences {
  return {
    theme,
    fontSize: 16,
    lineHeight: 1.75,
    contentWidth: 820,
    showOutline: true,
    typography: "newsreader",
    themePreset: "default"
  };
}

function setHost(kind: number): void {
  window.activeColorTheme = { kind };
}

describe("ConfigurationService.resolveTheme", () => {
  let configuration: ConfigurationService;

  beforeEach(() => {
    resetVscodeStub();
    configuration = new ConfigurationService();
  });

  afterEach(() => {
    configuration.dispose();
  });

  test("light / dark 属产品主题，任何宿主 kind 都不改结果", () => {
    const kinds = [
      ColorThemeKind.Light,
      ColorThemeKind.Dark,
      ColorThemeKind.HighContrast,
      ColorThemeKind.HighContrastLight
    ];
    for (const kind of kinds) {
      setHost(kind);
      expect(configuration.resolveTheme(prefs("light"))).toEqual({
        mode: "light",
        source: "product"
      });
      expect(configuration.resolveTheme(prefs("dark"))).toEqual({
        mode: "dark",
        source: "product"
      });
    }
  });

  test("system 从宿主 kind 取明暗，来源标 system", () => {
    setHost(ColorThemeKind.Light);
    expect(configuration.resolveTheme(prefs("system"))).toEqual({
      mode: "light",
      source: "system"
    });
    setHost(ColorThemeKind.HighContrastLight);
    expect(configuration.resolveTheme(prefs("system"))).toEqual({
      mode: "light",
      source: "system"
    });
    setHost(ColorThemeKind.Dark);
    expect(configuration.resolveTheme(prefs("system"))).toEqual({
      mode: "dark",
      source: "system"
    });
    setHost(ColorThemeKind.HighContrast);
    expect(configuration.resolveTheme(prefs("system"))).toEqual({
      mode: "dark",
      source: "system"
    });
  });

  test("auto 与 system 同义（ARC-006 §5.1 只定义四模式，auto 是历史配置别名）", () => {
    for (const kind of [ColorThemeKind.Light, ColorThemeKind.Dark]) {
      setHost(kind);
      expect(configuration.resolveTheme(prefs("auto"))).toEqual(
        configuration.resolveTheme(prefs("system"))
      );
    }
  });

  test("vscode 也取宿主明暗，但来源是 vscode：Webview 据此改走宿主变量", () => {
    setHost(ColorThemeKind.HighContrast);
    expect(configuration.resolveTheme(prefs("vscode"))).toEqual({
      mode: "dark",
      source: "vscode"
    });
    setHost(ColorThemeKind.HighContrastLight);
    expect(configuration.resolveTheme(prefs("vscode"))).toEqual({
      mode: "light",
      source: "vscode"
    });
  });

  test("缺参与非法配置都回退 auto，不产生第三种取色层", () => {
    setHost(ColorThemeKind.Light);
    expect(configuration.resolveTheme()).toEqual({ mode: "light", source: "system" });

    configValues.set("readora.theme", "solarized");
    expect(configuration.getPreferences().theme).toBe("auto");
    expect(configuration.resolveTheme()).toEqual({ mode: "light", source: "system" });

    configValues.set("readora.theme", undefined);
    expect(configuration.getPreferences().theme).toBe("auto");

    configValues.set("readora.theme", "vscode");
    expect(configuration.getPreferences().theme).toBe("vscode");
    expect(configuration.resolveTheme()).toEqual({ mode: "light", source: "vscode" });
  });

  test("五种模式都能原样读回（配置 enum 与契约 enum 必须同步）", () => {
    for (const theme of ["auto", "light", "dark", "vscode", "system"] as const) {
      configValues.set("readora.theme", theme);
      expect(configuration.getPreferences().theme).toBe(theme);
    }
  });
});

/**
 * 配置键形状（用户在宿主里报出的缺陷）。
 *
 * 缺陷形状是「写盘成功但读不回」：写与读落在同一枚键上才不会说谎，
 * 而 manifest 没声明的键在宿主里永远是默认值 —— 两边都得钉住。
 * 下面第二条同时是本替身的保真度自检：宿主会把点号子键丢掉，替身必须
 * 跟着丢，否则夹具与缺陷自洽，护栏形同虚设。
 */
describe("themePreset 的配置键往返", () => {
  let configuration: ConfigurationService;

  beforeEach(() => {
    resetVscodeStub();
    configuration = new ConfigurationService();
  });

  afterEach(() => {
    configuration.dispose();
  });

  test("写回的键、读回的键与 manifest 声明的键是同一枚", async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8")
    ) as { contributes: { configuration: { properties: Record<string, unknown> } } };

    await configuration.patchPreference("themePreset", "high-contrast");

    expect(configValues.get("readora.themePreset")).toBe("high-contrast");
    expect(configuration.getPreferences().themePreset).toBe("high-contrast");
    expect(manifest.contributes.configuration.properties).toHaveProperty(
      "readora.themePreset"
    );
  });

  test("与字符串叶同前缀的子键会被宿主整条丢掉（旧形状的复现）", () => {
    configValues.set("readora.theme", "auto");
    configValues.set("readora.theme.preset", "high-contrast");

    const config = workspace.getConfiguration("readora");
    expect(config.get("theme")).toBe("auto");
    expect(config.get("theme.preset")).toBeUndefined();
    // 宿主那句 `Ignoring …` 在替身里照抄：丢掉是无日志的静默行为，只能靠形状断言拦住。
    expect(ignoredConfigKeys).toContain(
      'Ignoring readora.theme.preset as readora.theme is "auto"'
    );
    // 读不回就是「点 High contrast 没反应」：偏好永远停在默认档。
    expect(configuration.getPreferences().themePreset).toBe("default");
  });
});
