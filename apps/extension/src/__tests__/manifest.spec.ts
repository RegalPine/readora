/**
 * manifest 护栏测试（ARC-004 §4.4）：
 * 1. 菜单只引用已注册命令；
 * 2. 每个菜单项必须带 when；
 * 3. when 口径必须覆盖 .md / .markdown；
 * 4. 配置项键名/说明/默认值与代码常量一致（ARC-008 §6.2）；
 * 5. M4 起再加：§4.1 的 P0 命令全部注册、§4.5 键位逐项对齐且 when 只认
 *    readora.readerActive（阅读器不在前台时快捷键必须让路）；
 * 6. M11 起再加：三条导出命令的存在与标题；M11.1 起右键菜单不再列它们
 *    （导出是阅读面里的动作，ARC-004 §4.4 的入口表只给 openReader / openToSide），
 *    再加 chromePath 配置项。
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  DEFAULT_THEME_PRESET,
  DEFAULT_TYPOGRAPHY,
  READER_TYPOGRAPHIES,
  THEME_MODES,
  THEME_PRESETS
} from "@readora/contracts";
import { DEFAULT_CUSTOM_CSS_MAX_CHARS } from "@readora/design-tokens";
import { CONFIG_SECTION, READORA_ACTIVE_CONTEXT, READORA_COMMANDS, READORA_VIEW_TYPE } from "../constants";
import {
  BYTES_PER_MB,
  createResourcePolicy,
  DEFAULT_MAX_IMAGE_MB,
  MAX_IMAGE_MB_RANGE
} from "../resources/resource-policy";

interface Manifest {
  main: string;
  engines: { vscode: string };
  activationEvents: string[];
  /** 发布元数据（IMP-003 §7.4）：许可证类型与 Marketplace 图标。 */
  license?: string;
  icon?: string;
  repository?: { type: string; url: string; directory: string };
  bugs?: { url: string };
  homepage?: string;
  contributes: {
    customEditors: {
      viewType: string;
      displayName: string;
      selector: { filenamePattern: string; scheme?: string }[];
      priority: string;
    }[];
    commands: { command: string; title: string }[];
    menus: Record<string, { command: string; when?: string; group?: string }[]>;
    keybindings: {
      command: string;
      key: string;
      mac?: string;
      when?: string;
      args?: unknown;
    }[];
    configuration: {
      title: string;
      properties: Record<
        string,
        {
          type: string;
          default?: unknown;
          minimum?: number;
          maximum?: number;
          /** 字符串型配置项（readora.customCss）的长度上限，与净化器同源。 */
          maxLength?: number;
          enum?: string[];
          enumDescriptions?: string[];
          description?: string;
        }
      >;
    };
  };
}

const manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf-8")
) as Manifest;

const registered = new Set(
  manifest.contributes.commands.map((command) => command.command)
);

type ConfigProperty = Manifest["contributes"]["configuration"]["properties"][string];

function property(key: string): ConfigProperty {
  const entry = manifest.contributes.configuration.properties[key];
  if (!entry) {
    throw new Error(`${key} is not declared in package.json`);
  }
  return entry;
}

describe("manifest 护栏", () => {
  test("§4.1 的 P0 命令 + M11 三条导出命令全部注册", () => {
    expect([...registered].sort()).toEqual([
      "readora.adjustContentWidth",
      "readora.exportHtml",
      "readora.exportPdf",
      "readora.exportPng",
      "readora.focusMode",
      "readora.openReader",
      "readora.openToSide",
      "readora.refresh",
      "readora.toggleOutline"
    ]);
    // 常量表与 manifest 不得两套事实：命令 ID 拼错在装配期就该被发现。
    expect([...registered].sort()).toEqual(
      Object.values(READORA_COMMANDS).sort()
    );
  });

  /**
   * 自定义编辑器声明（ARC-004 §4.2，M6 起改为原生面包屑依赖的前提）：
   * readora 以 CustomEditorProvider 形态接管 Markdown，宿主才会在编辑器上方
   * 画出原生面包屑与「打开方式」切换。viewType 必须与代码常量一致，priority
   * 必须是 default（0.13.1 起 readora 是 .md / .markdown 的默认打开方式，双击
   * 直接进阅读器；文本编辑器仍可经「打开方式」与 editorAssociations 拿回）。
   */
  test("customEditors 声明只读编辑器形态，priority=default 且选择器覆盖 .md/.markdown 并限定 scheme=file", () => {
    const editors = manifest.contributes.customEditors;
    expect(editors).toHaveLength(1);
    const [editor] = editors;
    expect(editor?.viewType).toBe(READORA_VIEW_TYPE);
    expect(editor?.displayName).toBe("Readora");
    expect(editor?.priority).toBe("default");
    expect(editor?.selector.map((item) => item.filenamePattern).sort()).toEqual([
      "*.markdown",
      "*.md"
    ]);
    // scheme: "file" 确保 gitfs:/git: 等虚拟协议不命中自定义编辑器，git diff 走内置文本差异视图
    for (const item of editor?.selector ?? []) {
      expect(item.scheme).toBe("file");
    }
  });

  test("宽度命令不进命令面板（它只服务键位）", () => {
    const palette = manifest.contributes.menus["commandPalette"] ?? [];
    const hidden = palette.filter((entry) => entry.when === "false");
    expect(hidden.map((entry) => entry.command)).toEqual([
      READORA_COMMANDS.ADJUST_CONTENT_WIDTH
    ]);
  });

  test("菜单只引用已注册命令", () => {
    for (const entries of Object.values(manifest.contributes.menus)) {
      for (const entry of entries) {
        expect(registered.has(entry.command)).toBe(true);
      }
    }
  });

  test("每个菜单项必须带非空 when", () => {
    for (const entries of Object.values(manifest.contributes.menus)) {
      for (const entry of entries) {
        expect(entry.when, `${entry.command} 缺少 when`).toBeTruthy();
      }
    }
  });

  test("不再贡献 editor/context 与 explorer/context（priority=default 后右键菜单冗余）", () => {
    expect(manifest.contributes.menus["editor/context"]).toBeUndefined();
    expect(manifest.contributes.menus["explorer/context"]).toBeUndefined();
  });

  test("键位只绑定已注册命令", () => {
    for (const keybinding of manifest.contributes.keybindings) {
      expect(registered.has(keybinding.command)).toBe(true);
    }
  });

  /**
   * ARC-004 §4.5 的键位基线（含偏差 D-3 的实际取值）逐项锁定：
   * 阅读器专属键必须带 readora.readerActive，否则会把 VS Code 全局键位抢掉。
   */
  test("§4.5 键位基线逐项对齐，且阅读器专属键受 readerActive 约束", () => {
    const byCommand = new Map<string, (typeof manifest.contributes.keybindings)[number][]>();
    for (const keybinding of manifest.contributes.keybindings) {
      const list = byCommand.get(keybinding.command) ?? [];
      list.push(keybinding);
      byCommand.set(keybinding.command, list);
    }

    const baseline: { command: string; key: string; mac: string; args?: number }[] = [
      { command: READORA_COMMANDS.OPEN_READER, key: "ctrl+alt+r", mac: "cmd+alt+r" },
      { command: READORA_COMMANDS.FOCUS_MODE, key: "ctrl+alt+f", mac: "cmd+alt+f" },
      { command: READORA_COMMANDS.TOGGLE_OUTLINE, key: "ctrl+alt+o", mac: "cmd+alt+o" },
      { command: READORA_COMMANDS.ADJUST_CONTENT_WIDTH, key: "ctrl+alt+left", mac: "cmd+alt+left", args: -1 },
      { command: READORA_COMMANDS.ADJUST_CONTENT_WIDTH, key: "ctrl+alt+right", mac: "cmd+alt+right", args: 1 }
    ];
    expect(manifest.contributes.keybindings).toHaveLength(baseline.length);

    for (const expected of baseline) {
      const entry = (byCommand.get(expected.command) ?? []).find(
        (candidate) => candidate.key === expected.key
      );
      expect(entry, `${expected.command} 缺 ${expected.key}`).toBeTruthy();
      expect(entry?.mac).toBe(expected.mac);
      if (expected.args !== undefined) {
        expect(entry?.args).toBe(expected.args);
      }
      // 打开命令是全局入口，其余只在阅读器激活时生效。
      expect(entry?.when ?? "").toBe(
        expected.command === READORA_COMMANDS.OPEN_READER
          ? ""
          : READORA_ACTIVE_CONTEXT
      );
    }
  });

  test("入口与引擎声明存在", () => {
    expect(manifest.main).toBe("./dist/extension.js");
    expect(manifest.engines.vscode).toBeTruthy();
  });

  test("发布元数据成对存在：license ↔ 根 LICENSE，icon ↔ 图标实体（IMP-003 §7.4）", () => {
    expect(manifest.license).toBe("MIT");
    // manifest 写了 MIT 而仓库根没有 LICENSE 的话，vsce 只是少收一个文件，
    // Marketplace 的许可证页会是空的 —— 两边必须同时成立才算数。
    // 相对路径从本 spec 出发：../../ = apps/extension，../../../../ = 仓库根。
    expect(readFileSync(new URL("../../../../LICENSE", import.meta.url), "utf-8")).toContain(
      "MIT License"
    );

    expect(manifest.icon).toBe("resources/icon.png");
    const icon = readFileSync(new URL(`../../${manifest.icon}`, import.meta.url));
    // PNG 签名 + IHDR 宽高：vsce 对不足 128×128 的图标直接拒绝打包，卡在下限
    // 才不会到发布环节才发现图标被换小了。
    expect(icon.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(icon.readUInt32BE(16)).toBe(128);
    expect(icon.readUInt32BE(20)).toBe(128);
  });

  test("repository / bugs / homepage 成套指向发布仓库（docs DEFER-02 已闭合）", () => {
    // Marketplace 的「源码地址」只认 repository.url；vsce 也拿它作为基准去改写
    // 包内 README 的相对链接。monorepo 必须同时给 directory，否则链接指到仓库根
    // 而不是 apps/extension 下真正的那份 README。半填比不填更糟，所以整对象断言。
    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/RegalPine/readora.git",
      directory: "apps/extension"
    });
    expect(manifest.bugs).toEqual({ url: "https://github.com/RegalPine/readora/issues" });
    expect(manifest.homepage).toBe("https://github.com/RegalPine/readora#readme");
  });

  test("资源策略配置项与代码默认值双向锁定", () => {
    expect(Object.keys(manifest.contributes.configuration.properties).sort()).toEqual([
      "readora.contentWidth",
      "readora.customCss",
      "readora.export.chromePath",
      "readora.fontSize",
      "readora.lineHeight",
      "readora.resources.allowExternalImages",
      "readora.resources.maxImageSizeMb",
      "readora.showOutline",
      "readora.theme",
      "readora.themePreset",
      "readora.typography"
    ]);

    const external = property("readora.resources.allowExternalImages");
    expect(external.type).toBe("boolean");
    expect(external.default).toBe(false);
    // 默认值必须与 createResourcePolicy() 的取值一致，否则「文档说的默认」
    // 和「实际生效的默认」会随版本漂移。
    expect(createResourcePolicy().allowExternalImages).toBe(external.default);

    const maxSize = property("readora.resources.maxImageSizeMb");
    expect(maxSize.type).toBe("number");
    expect(maxSize.default).toBe(DEFAULT_MAX_IMAGE_MB);
    expect(maxSize.minimum).toBe(MAX_IMAGE_MB_RANGE.min);
    expect(maxSize.maximum).toBe(MAX_IMAGE_MB_RANGE.max);
    expect(createResourcePolicy().maxResourceSize).toBe(
      (maxSize.default as number) * BYTES_PER_MB
    );
  });

  /**
   * M6 §1 的三新增项同样双向锁定：manifest 写的默认值必须就是契约的默认值，
   * enum 必须就是契约的取值表。弹层（config.patch）走的是同一套契约，任何一侧
   * 悄悄加一个取值，另一侧就会把用户配出来的值当非法值拒掉。
   */
  test("排版 / 预设 / 自定义 CSS 三个配置项与契约取值表双向锁定", () => {
    const typography = property("readora.typography");
    expect(typography.type).toBe("string");
    expect(typography.default).toBe(DEFAULT_TYPOGRAPHY);
    expect([...(typography.enum ?? [])].sort()).toEqual([...READER_TYPOGRAPHIES].sort());
    expect(typography.enumDescriptions).toHaveLength(READER_TYPOGRAPHIES.length);

    const preset = property("readora.themePreset");
    expect(preset.type).toBe("string");
    expect(preset.default).toBe(DEFAULT_THEME_PRESET);
    expect([...(preset.enum ?? [])].sort()).toEqual([...THEME_PRESETS].sort());
    expect(preset.enumDescriptions).toHaveLength(THEME_PRESETS.length);

    const customCss = property("readora.customCss");
    expect(customCss.type).toBe("string");
    expect(customCss.default).toBe("");
    // 上限与净化器同源：manifest 存得下而净化器整段拒绝的话，用户会看到
    // 「设置里配好了但阅读器不认」。本 spec 不 import configuration-service
    // （它依赖 vscode），所以直接对净化器的常量而不是它的转发别名。
    expect(customCss.maxLength).toBe(DEFAULT_CUSTOM_CSS_MAX_CHARS);
  });

  /**
   * M11 导出入口护栏。
   *
   * 三档格式是产品味而不是实现细节：标题里少一档，用户在命令面板里就找不到它。
   * 右键菜单不列导出：那两处只放「打开阅读器」的两个入口（ARC-004 §4.4 的入口表），
   * 导出的主入口是顶栏 Export 下拉，三条命令继续留在命令面板里可搜到。
   */
  test("三条导出命令成对注册，且不进任何菜单", () => {
    const titles = new Map(
      manifest.contributes.commands.map((command) => [command.command, command.title])
    );
    expect(titles.get(READORA_COMMANDS.EXPORT_HTML)).toBe("Readora: Export as HTML");
    expect(titles.get(READORA_COMMANDS.EXPORT_PDF)).toBe("Readora: Export as PDF");
    expect(titles.get(READORA_COMMANDS.EXPORT_PNG)).toBe("Readora: Export as PNG");

    // 导出命令不在任何菜单中（只留命令面板可搜）
    for (const entries of Object.values(manifest.contributes.menus)) {
      for (const entry of entries) {
        expect(entry.command).not.toMatch(/^readora\.export/);
      }
    }

    // 不进命令面板的只有宽度那一枚：三条导出命令都要能搜到。
    const palette = manifest.contributes.menus["commandPalette"] ?? [];
    for (const entry of palette) {
      expect(entry.command).not.toMatch(/^readora\.export/);
    }
  });

  /**
   * 配置键的形状护栏：一个键不得同时是叶和枝。
   *
   * 宿主把 settings.json 的点号键展开成树，已有字符串叶 `readora.theme` 时，
   * 子键 `readora.theme.preset` 会被整句 `Ignoring …` 丢弃：写盘照样落进文件，
   * 读回来却永远是 undefined，于是「Reader Settings 点 High contrast 没反应」。
   * 本替身已按宿主的展开规则建模（见 `__stubs__/vscode.ts` 的 ignoredConfigKeys），
   * 但这条冲突在 manifest 层就是死的，所以这里按声明表直接判，不依赖运行期读数。
   */
  test("配置键不得互为前缀（叶与枝同名会被宿主静默丢弃）", () => {
    const keys = Object.keys(manifest.contributes.configuration.properties);
    for (const key of keys) {
      for (const other of keys) {
        if (other !== key) {
          expect(
            other.startsWith(`${key}.`),
            `${key} 是字符串叶时 ${other} 读不出来：必须改成互不为前缀的扁平键`
          ).toBe(false);
        }
      }
    }
  });

  /**
   * `readora.export.chromePath`：默认空串 = 自动探测，因此描述必须同时说清
   * 「只有 PDF/PNG 用得到」与「HTML 不依赖浏览器」—— 否则用户会以为
   * 没装 Chrome 就连 HTML 也导不了。键名也必须与 getExportChromePath() 读的一致。
   */
  test("chromePath 配置项默认空串且描述不误导 HTML 通道", () => {
    const chromePath = property("readora.export.chromePath");
    expect(chromePath.type).toBe("string");
    expect(chromePath.default).toBe("");
    expect(chromePath.description).toContain("PDF");
    expect(chromePath.description).toContain("PNG");
    expect(chromePath.description).toContain("HTML");
    expect(chromePath.description).toContain("CHROME_PATH");
    // 代码读的键与本处必须一字不差：配置键名写错不会报错，只会永远是默认值。
    // `ConfigurationService.getExportChromePath()` 读的是 section=CONFIG_SECTION
    // 下的 `export.chromePath`，拼起来正是下面这个键。
    expect(`${CONFIG_SECTION}.export.chromePath`).toBe("readora.export.chromePath");
    expect(() => property(`${CONFIG_SECTION}.export.chromePath`)).not.toThrow();
  });

  test("readora.theme 的 enum 与契约 THEME_MODES 逐项一致", () => {
    const theme = property("readora.theme");
    expect(theme.type).toBe("string");
    expect(theme.default).toBe("auto");
    // 顺序无关，但一名都不能差：漏一个模式会让用户配不出来，多一个会让 Host 读到非法值。
    expect([...(theme.enum ?? [])].sort()).toEqual([...THEME_MODES].sort());
    expect(theme.enumDescriptions).toHaveLength(THEME_MODES.length);
  });

  test("每个配置项都有说明且键名以 readora 开头", () => {
    for (const [key, entry] of Object.entries(
      manifest.contributes.configuration.properties
    )) {
      expect(key.startsWith(`${CONFIG_SECTION}.`)).toBe(true);
      expect(entry.description, `${key} 缺少 description`).toBeTruthy();
    }
  });
});