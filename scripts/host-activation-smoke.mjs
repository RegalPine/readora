/**
 * Host 产物激活冒烟（IMP-001 §7，紧接 build:host 之后）。
 *
 * 为什么单测全绿还不够：单测加载的是 TS 源码 + `__stubs__/vscode.ts`，跑在 ESM 里，
 * `import.meta.url` 天然可用；交付物却是 esbuild 出的单文件 CJS，`import.meta` 会被
 * 换成空对象。css-tree 的 ESM 入口正是靠 `createRequire(import.meta.url)` 在模块加载时
 * 读同包 JSON —— 于是 dist/extension.js 一被 require 就抛 TypeError，扩展激活失败、
 * 六个命令一个都没注册，而 manifest 里的右键菜单照旧存在。用户在 VS Code 里只会看到
 * 「command 'readora.openReader' not found」，构建与门禁却全绿。
 *
 * 本脚本按宿主的方式加载那个产物：拦截 `require("vscode")` 换成最小 stub，
 * 跑一遍 activate()，断言 package.json 声明的每条命令都真的注册成功、
 * 且命令体可以调用。任何加载期异常都在这里当场失败，不留到用户侧。
 *
 * 默认测仓库工作区的 dist/extension.js；`pnpm verify` 会额外把 vsix 里的那份
 * 解出来传成本脚本的入参 —— 门禁要判的是交付物本身，不是构建中间产物。
 */
import { readFileSync } from "node:fs";
import Module from "node:module";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bundlePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, "apps", "extension", "dist", "extension.js");
// 安装布局（<extension>/dist/extension.js）与工作区布局（apps/extension/dist/…）一致：
// manifest 与 resources/ 都在 bundle 的上两级目录，所以同一份产物在哪测都对得上。
const packageDir = path.dirname(path.dirname(bundlePath));
const manifestPath = path.join(packageDir, "package.json");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

function fail(message, cause) {
  console.error(`[smoke] FAIL ${message}`);
  if (cause) {
    console.error(
      String(cause?.stack ?? cause)
        .split("\n")
        .slice(0, 6)
        .join("\n")
    );
  }
  process.exit(1);
}

/** 与 `__stubs__/vscode.ts` 同样的口径：只建模 activate 路径真的会用到的 API。 */
const registeredCommands = new Map();
const registeredCustomEditors = [];
const errorMessages = [];
const warningMessages = [];
const infoMessages = [];

function disposable() {
  return { dispose() {} };
}

class FakeUri {
  constructor(scheme, pathValue) {
    this.scheme = scheme;
    this.path = pathValue;
  }

  static file(pathValue) {
    return new FakeUri("file", pathValue.startsWith("/") ? pathValue : `/${pathValue}`);
  }

  static parse(value) {
    const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:)\/\/?([^?#]*)/.exec(value);
    if (!match) {
      return new FakeUri("file", value);
    }
    return new FakeUri(match[1].slice(0, -1), match[2]);
  }

  static joinPath(base, ...segments) {
    return new FakeUri(base.scheme, path.posix.join(base.path, ...segments));
  }

  get fsPath() {
    return this.path;
  }

  toString() {
    return `${this.scheme}://${this.path}`;
  }
}

const vscodeStub = {
  Uri: FakeUri,
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  EventEmitter: class {
    constructor() {
      this.listeners = new Set();
      this.event = (listener) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
    }

    fire(...args) {
      for (const listener of this.listeners) {
        listener(...args);
      }
    }

    dispose() {
      this.listeners.clear();
    }
  },
  window: {
    // 冒烟阶段没有打开任何编辑器：命令必须走「无可读目标」的分支，而不是崩在半路。
    activeTextEditor: undefined,
    activeColorTheme: { kind: 1 },
    visibleTextEditors: [],
    onDidChangeActiveColorTheme: () => disposable(),
    createOutputChannel: (name) => ({
      name,
      appendLine: () => {},
      append: () => {},
      replace: () => {},
      show: () => {},
      hide: () => {},
      dispose: () => {}
    }),
    showErrorMessage: (message) => {
      errorMessages.push(message);
    },
    showWarningMessage: (message) => {
      warningMessages.push(message);
    },
    // M11：保存对话框是本扩展唯一的写盘授权边界，而冒烟里没有用户。命令体一旦
    // 走到这一步就说明「无目标即早退」的护栏漏了，后面接的一定是真写盘。
    showSaveDialog: () => {
      fail("a command body reached showSaveDialog() during activation smoke");
    },
    showInformationMessage: (message) => {
      infoMessages.push(message);
      fail(`a command body reported success during activation smoke: ${message}`);
    },
    createWebviewPanel: () => {
      throw new Error("activate() must not create a webview panel");
    },
    // 自定义编辑器形态：注册 provider 本身不建面板，冒烟阶段允许；真正的面板创建
    // 只会发生在用户以 readora「打开方式」选中某文档时，而冒烟里没有这一步。
    // provider / options 形参在冒烟里用不到，按 JS 允许的实现签名省略（多实参会被忽略）。
    registerCustomEditorProvider: (viewType) => {
      registeredCustomEditors.push(viewType);
      return disposable();
    }
  },
  workspace: {
    workspaceFolders: undefined,
    textDocuments: [],
    getConfiguration: () => ({
      get: (_key, fallback) => fallback,
      has: () => false,
      inspect: () => undefined,
      update: async () => {}
    }),
    onDidChangeConfiguration: () => disposable(),
    onDidChangeTextDocument: () => disposable(),
    onDidSaveTextDocument: () => disposable(),
    createFileSystemWatcher: () => ({
      onDidChange: () => disposable(),
      onDidCreate: () => disposable(),
      onDidDelete: () => disposable(),
      dispose: () => {}
    }),
    fs: {
      stat: async () => {
        throw new Error("smoke does not read the filesystem");
      },
      readFile: async () => {
        throw new Error("smoke does not read the filesystem");
      },
      // 导出链路的全部落盘出口（交付物与临时 HTML）都在这三个 API 上，
      // 冒烟里碰见任何一个都直接失败：授权对话框还没弹过，文件不可能该出现。
      writeFile: async () => {
        fail("a command body wrote a file during activation smoke");
      },
      delete: async () => {
        fail("a command body deleted a file during activation smoke");
      },
      createDirectory: async () => {
        fail("a command body created a directory during activation smoke");
      }
    }
  },
  commands: {
    registerCommand: (id, handler) => {
      registeredCommands.set(id, handler);
      return {
        dispose: () => {
          registeredCommands.delete(id);
        }
      };
    },
    executeCommand: async (id, ...args) => {
      const handler = registeredCommands.get(id);
      if (!handler) {
        throw new Error(`command '${id}' not found`);
      }
      return handler(...args);
    }
  },
  env: {
    openExternal: async () => {
      fail("a command body opened an external URI during activation smoke");
    },
    language: "en",
    appName: "Smoke Host"
  },
  extensions: {
    getExtension: () => undefined
  }
};

// 产物的 `main` 是 CJS，宿主用 require 加载；这里以同样的方式加载，
// 只把外部的 "vscode" 模块换成 stub（其余依赖继续走正常解析）。
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return vscodeStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

let bundle;
try {
  bundle = createRequire(import.meta.url)(bundlePath);
} catch (error) {
  fail(`dist/extension.js failed to load: ${error?.message}`, error);
} finally {
  Module._load = originalLoad;
}

if (typeof bundle.activate !== "function" || typeof bundle.deactivate !== "function") {
  fail("dist/extension.js does not export activate/deactivate");
}

const context = {
  extensionUri: FakeUri.file(packageDir),
  extensionPath: packageDir,
  subscriptions: []
};

try {
  bundle.activate(context);
} catch (error) {
  fail(`activate() threw: ${error?.message}`, error);
}

const declared = manifest.contributes.commands.map((entry) => entry.command);
const missing = declared.filter((id) => !registeredCommands.has(id));
if (missing.length > 0) {
  fail(
    `activate() registered ${declared.length - missing.length}/${declared.length} commands; ` +
      `missing: ${missing.join(", ")} —— 用户在菜单里点这些命令会得到 "command not found"`
  );
}
// deactivate() 会注销命令，计数必须在这之前取，否则末行日志会报 0/N。
const registeredCount = registeredCommands.size;

// 自定义编辑器（原生面包屑的载体）必须随 activate 注册：漏了它，manifest 里的
// customEditors 声明指向一个不存在的 viewType，用户「打开方式」列表里根本没有 readora。
const declaredEditors = (manifest.contributes.customEditors ?? []).map((e) => e.viewType);
const missingEditors = declaredEditors.filter((vt) => !registeredCustomEditors.includes(vt));
if (missingEditors.length > 0) {
  fail(
    `activate() registered ${declaredEditors.length - missingEditors.length}/${declaredEditors.length} ` +
      `custom editors; missing: ${missingEditors.join(", ")}`
  );
}

// 命令体也要真的可调用：注册成功但一进函数就炸（契约 schema、依赖装配）是同一类事故。
// 清单故意取自 manifest 而不是手写：手写那份在新加命令时会静默少调几条，
// 于是「命令一按就抛」这类事故又能全绿过关（M11 加三条导出命令时正是这么漏的）。
try {
  for (const id of declared) {
    await registeredCommands.get(id)?.(-1);
  }
} catch (error) {
  fail(`a registered command threw when invoked: ${error?.message}`, error);
}

// 导出三条的第二条早退分支：参数换成一个能解析的 markdown URI，于是命令体越过
// 「无目标」判断、真的去查会话 —— 空窗口里没有阅读会话，必须落回一句提示。
// 这条分支是计划锁定的口径（不弹对话框、不 spawn Chrome、不写盘），上面那几个
// 会 fail 的 stub 就是它的断言：走到任何一步都当场炸。
const EXPORT_NO_SESSION_NOTICE = "Readora: open the document in the reader before exporting.";
const EXPORT_COMMANDS = ["readora.exportHtml", "readora.exportPdf", "readora.exportPng"];
try {
  for (const id of EXPORT_COMMANDS) {
    await registeredCommands.get(id)?.(FakeUri.file("/tmp/readora-smoke/document.md"));
  }
} catch (error) {
  fail(`an export command threw when invoked without a reader session: ${error?.message}`, error);
}
const exportNotices = errorMessages.filter((message) => message === EXPORT_NO_SESSION_NOTICE);
if (exportNotices.length !== EXPORT_COMMANDS.length) {
  fail(
    `export commands must all early-exit with "${EXPORT_NO_SESSION_NOTICE}", ` +
      `got ${exportNotices.length}/${EXPORT_COMMANDS.length} —— 没有阅读会话时它们不该碰任何 I/O`
  );
}
if (infoMessages.length > 0 || warningMessages.length > 0) {
  fail(
    "export path reported a success or warning during activation smoke: " +
      [...infoMessages, ...warningMessages].join(" | ")
  );
}

try {
  bundle.deactivate();
} catch (error) {
  fail(`deactivate() threw: ${error?.message}`, error);
}

console.log(
  `[smoke] OK dist/extension.js loaded, activate() registered ${registeredCount}/${declared.length} commands, ` +
    `all command bodies invoked (no-target notices: ${errorMessages.length}, ` +
    `export early-exits: ${exportNotices.length}/${EXPORT_COMMANDS.length})`
);
