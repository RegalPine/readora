/**
 * 测试专用 vscode stub（IMP-001 测试策略）。
 *
 * 只建模被测路径用到的 API；未建模导出一律不存在，
 * 误用会以 TypeError 立即暴露，而不是静默通过。
 * 本文件不参与覆盖率统计，也不得被生产代码引用。
 *
 * M3 起补齐 URI 的段语义：path 为解码形态、toString 重新百分号编码，
 * 带 query / fragment / with()，否则资源解析与 webview URI 版本号
 * 这两类断言无从表达（fsPath 单字段模型区分不了「编码」与「越界」）。
 *
 * 盘符差异也在建模范围内：初始版本在 macOS 上开发，那时 path 与 fsPath 同形，
 * 「不建模 Windows 盘符」还不算撒谎。但真机夹具测试（resource-fixture.spec.ts）
 * 要在三平台上都真的落到同一个 inode，替身就必须像宿主一样把 `C:\x` 记成
 * `/C:/x`、把 fsPath 还给操作系统能用的形状 —— 否则 `posix.dirname('/C:\x\a.md')`
 * 会把整个带反斜杠的串当成一个文件名，目录算成 `/`，夹具在 Windows 上全变成假路径。
 */
import { posix } from "node:path";

/** 与 vscode-uri 同口径：同一个 URI 字符串的 fsPath 形状随**运行平台**变。 */
const IS_WINDOWS = process.platform === "win32";
/** 操作系统形态的盘符绝对路径：`C:\x` 或 `C:/x`。 */
const OS_DRIVE_PATH = /^[A-Za-z]:[\\/]/u;
/** URI path 形态的盘符绝对路径：`/C:/x`（前导斜杠是 URI 语法，不属于文件系统）。 */
const URI_DRIVE_PATH = /^\/([A-Za-z]:)(\/.*)?$/u;

function percentEncodePath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function percentDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query: string,
    readonly fragment: string
  ) {}

  static file(path: string): Uri {
    // Windows 上宿主把盘符路径写成 `/C:/x` 并统一用正斜杠；POSIX 上反斜杠是
    // 合法文件名字符，绝不能替用户改写 —— 那会让夹具与真实宿主各说各话。
    const slashed = IS_WINDOWS ? path.replace(/\\/g, "/") : path;
    const withDriveSlash = IS_WINDOWS && OS_DRIVE_PATH.test(slashed) ? `/${slashed}` : slashed;
    const normalized = withDriveSlash.startsWith("/")
      ? withDriveSlash
      : `/${withDriveSlash}`;
    return new Uri("file", "", normalized, "", "");
  }

  static parse(value: string): Uri {
    const match =
      /^([a-zA-Z][a-zA-Z0-9+.-]*:)?(\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(value);
    if (!match) {
      return new Uri("file", "", value, "", "");
    }
    const scheme = match[1] ? match[1].slice(0, -1).toLowerCase() : "file";
    const authority = match[2] ? match[2].slice(2) : "";
    const query = match[4] ? match[4].slice(1) : "";
    const fragment = match[5] ? match[5].slice(1) : "";
    return new Uri(scheme, authority, percentDecode(match[3] ?? ""), query, fragment);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const tail = segments
      .map((segment) => segment.replace(/^\/+/, ""))
      .filter((segment) => segment.length > 0);
    const head = base.path.endsWith("/") ? base.path.slice(0, -1) : base.path;
    const path = posix.normalize([head, ...tail].join("/"));
    return new Uri(base.scheme, base.authority, path, "", "");
  }

  /**
   * 操作系统能直接用的路径：POSIX 上就是解码后的 path，
   * Windows 上剥掉 URI 语法的前导斜杠并把分隔符还给反斜杠。
   */
  get fsPath(): string {
    if (!IS_WINDOWS) {
      return this.path;
    }
    const drive = URI_DRIVE_PATH.exec(this.path);
    return drive ? `${drive[1]}${drive[2] ?? ""}`.replace(/\//g, "\\") : this.path;
  }

  with(change: {
    scheme?: string;
    authority?: string;
    path?: string;
    query?: string;
    fragment?: string;
  }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment
    );
  }

  toString(): string {
    const authority =
      this.authority.length > 0
        ? `//${this.authority}`
        : this.scheme === "file"
          ? "//"
          : "";
    const query = this.query.length > 0 ? `?${this.query}` : "";
    const fragment = this.fragment.length > 0 ? `#${this.fragment}` : "";
    return `${this.scheme}:${authority}${percentEncodePath(this.path)}${query}${fragment}`;
  }
}

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 } as const;

export const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64
} as const;

export const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 } as const;

interface StubDisposable {
  dispose(): void;
}

class StubEmitter<Args extends unknown[]> {
  private readonly listeners = new Set<(...args: Args) => void>();

  readonly event = (listener: (...args: Args) => void): StubDisposable => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  };

  fire(...args: Args): void {
    for (const listener of [...this.listeners]) {
      listener(...args);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class EventEmitter<Args extends unknown[] = []> {
  private readonly emitter = new StubEmitter<Args>();
  readonly event = this.emitter.event;
  fire(...args: Args): void {
    this.emitter.fire(...args);
  }
  dispose(): void {
    this.emitter.dispose();
  }
}

export class FakeWebview {
  html = "";
  readonly cspSource = "https://stub.vscode-cdn.net";
  readonly postedMessages: unknown[] = [];
  /** 自定义编辑器 provider 会写 `webview.options`（enableScripts / localResourceRoots）。 */
  options?: { enableScripts?: boolean; localResourceRoots?: readonly Uri[] };
  private readonly messageEmitter = new StubEmitter<[unknown]>();
  readonly onDidReceiveMessage = this.messageEmitter.event;

  postMessage(message: unknown): Promise<boolean> {
    this.postedMessages.push(message);
    return Promise.resolve(true);
  }

  /** 保留 query：webview URI 的版本号必须在测试里可见。 */
  asWebviewUri(uri: Uri): Uri {
    const suffix = uri.query.length > 0 ? `?${uri.query}` : "";
    return Uri.parse(
      `https://stub.vscode-cdn.net${percentEncodePath(uri.path)}${suffix}`
    );
  }

  /** 测试注入：模拟 Webview 发来的消息。 */
  receive(raw: unknown): void {
    this.messageEmitter.fire(raw);
  }
}

export class FakePanel {
  readonly webview = new FakeWebview();
  readonly revealedColumns: unknown[] = [];
  /** 面板可见性驱动 readora.readerActive 上下文键（ARC-004 §4.5 键位 when）。 */
  visible = true;
  private readonly disposeEmitter = new StubEmitter<[]>();
  readonly onDidDispose = this.disposeEmitter.event;
  private readonly viewStateEmitter = new StubEmitter<
    [{ active: boolean; visible: boolean }]
  >();
  readonly onDidChangeViewState = this.viewStateEmitter.event;
  private disposed = false;

  constructor(
    readonly viewType: string,
    public title: string,
    readonly showOptions: unknown,
    readonly column: unknown
  ) {}

  reveal(column?: unknown): void {
    this.revealedColumns.push(column);
  }

  /** 测试注入：模拟面板显示 / 隐藏。 */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.viewStateEmitter.fire({ active: visible, visible });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
    this.viewStateEmitter.dispose();
  }
}

export const createdPanels: FakePanel[] = [];
/** 注册的自定义编辑器 provider（registerCustomEditorProvider 的调用记录）。 */
export const customEditorProviders: { viewType: string; provider: unknown }[] = [];
export const errorMessages: string[] = [];
export const warningMessages: string[] = [];
export const openedExternally: string[] = [];
/**
 * 信息通知（带按钮的那一类）。
 *
 * 导出成功的通知只有一枚 `Open`，于是「写了盘」与「告诉用户写了盘」是两件事，
 * 测试必须能分开断言：前者看 `writtenFiles`，后者看这里。
 */
export const infoMessages: { message: string; actions: string[] }[] = [];
/** 测试注入：用户在通知里按下的按钮标题（没按为 undefined）。 */
export const infoReply = { picked: undefined as string | undefined };
/**
 * 保存对话框的可注入状态：`path` 为 null 就是用户取消（对应真实 API 返回 undefined）。
 * `requests` 留给「默认落盘是不是同名同目录」这一类断言。
 */
export const saveDialog = {
  path: null as string | null,
  requests: [] as { defaultUri?: Uri; filters: Record<string, readonly string[]> }[]
};
/** 每个 OutputChannel 写入的行（F11-013 / F11-014 的可断言出口）。 */
export const outputLines = new Map<string, string[]>();

export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3
} as const;

export const window = {
  activeTextEditor: undefined as
    | { document: { uri: Uri; languageId: string } }
    | undefined,
  activeColorTheme: { kind: ColorThemeKind.Dark } as { kind: number },
  createOutputChannel(name: string): StubDisposable & {
    appendLine(value: string): void;
    append(value: string): void;
    show(): void;
  } {
    const lines: string[] = [];
    outputLines.set(name, lines);
    return {
      appendLine(value: string): void {
        lines.push(value);
      },
      append(value: string): void {
        lines.push(value);
      },
      show(): void {
        // 无头 stub 里没有可见性可言，记录调用即可。
        lines.push("<show>");
      },
      dispose(): void {
        outputLines.delete(name);
      }
    };
  },
  createWebviewPanel(
    viewType: string,
    title: string,
    column: unknown,
    options: unknown
  ): FakePanel {
    const panel = new FakePanel(viewType, title, options, column);
    createdPanels.push(panel);
    return panel;
  },
  registerCustomEditorProvider(
    viewType: string,
    provider: unknown,
    _options?: unknown
  ): StubDisposable {
    customEditorProviders.push({ viewType, provider });
    return {
      dispose(): void {
        const index = customEditorProviders.findIndex(
          (entry) => entry.viewType === viewType
        );
        if (index >= 0) {
          customEditorProviders.splice(index, 1);
        }
      }
    };
  },
  onDidChangeActiveColorTheme(listener: () => void): StubDisposable {
    colorThemeChangeListeners.add(listener);
    return {
      dispose(): void {
        colorThemeChangeListeners.delete(listener);
      }
    };
  },
  showErrorMessage(message: string): Promise<undefined> {
    errorMessages.push(message);
    return Promise.resolve(undefined);
  },
  showInformationMessage(
    message: string,
    ...actions: string[]
  ): Promise<string | undefined> {
    infoMessages.push({ message, actions });
    return Promise.resolve(infoReply.picked);
  },
  showSaveDialog(options: {
    defaultUri?: Uri;
    filters: Record<string, readonly string[]>;
  }): Promise<Uri | undefined> {
    saveDialog.requests.push(options);
    return Promise.resolve(saveDialog.path === null ? undefined : Uri.file(saveDialog.path));
  },
  showWarningMessage(message: string): Promise<undefined> {
    warningMessages.push(message);
    return Promise.resolve(undefined);
  }
};

export const env = {
  openExternal(uri: Uri): Promise<boolean> {
    openedExternally.push(uri.toString());
    return Promise.resolve(true);
  }
};

/** 文件系统的可注入状态：键为 fsPath。 */
export interface StubFileStat {
  type: number;
  size: number;
  mtime: number;
  ctime?: number;
}

export const fileStates = new Map<string, StubFileStat>();
export const configValues = new Map<string, unknown>();
export const statCalls: string[] = [];
export const readFileCalls: string[] = [];
/** 写盘出口（fs.writeFile）：取消对话框那一条用例要断言的是它为空。 */
export const writtenFiles = new Map<string, Uint8Array>();
/** 删除出口（fs.delete）的调用序列：临时件必删就钉在这里。 */
export const deletedFiles: string[] = [];

/**
 * 宿主的点号配置键 → 一棵树，本替身按同一规则建模。
 *
 * 取证于 workbench 产物里的配置装配逻辑：`a.b.c` 先按段下降，段上没有值就补一层
 * 空对象，段上是对象就继续，段上是字符串 / 数字 / null 则整句 `Ignoring a.b.c as
 * a.b is <值>` **把这条键丢掉**；落到最后一段则是直接覆盖。之前这里是扁平 Map 直读，
 * 于是「`readora.theme` 是字符串 + `readora.theme.preset` 是子键」这种形状在单测里
 * 读得出、在宿主里读不出 —— 夹具与缺陷自洽，护栏等于零。
 */
export const ignoredConfigKeys: string[] = [];

interface ConfigTreeNode {
  [segment: string]: unknown;
}

function assignConfigKey(tree: ConfigTreeNode, key: string, value: unknown): void {
  const segments = key.split(".");
  const leaf = segments.pop() as string;
  let node: ConfigTreeNode = tree;
  for (const [index, segment] of segments.entries()) {
    const child = node[segment];
    if (child === undefined) {
      node[segment] = Object.create(null) as ConfigTreeNode;
    } else if (child === null || typeof child !== "object") {
      // 丢弃原因与宿主同一句措辞：用例可以断言「这条键真的被宿主吃掉了」。
      ignoredConfigKeys.push(
        `Ignoring ${key} as ${segments.slice(0, index + 1).join(".")} is ${JSON.stringify(child)}`
      );
      return;
    }
    node = node[segment] as ConfigTreeNode;
  }
  node[leaf] = value;
}

function readConfigKey(key: string): unknown {
  const tree: ConfigTreeNode = Object.create(null);
  // 插入序就是 settings.json 的键序：谁先落地谁占住那一段，与宿主一致。
  for (const [storedKey, value] of configValues) {
    assignConfigKey(tree, storedKey, value);
  }
  let node: unknown = tree;
  for (const segment of key.split(".")) {
    if (typeof node !== "object" || node === null) {
      return undefined;
    }
    node = (node as ConfigTreeNode)[segment];
  }
  return node;
}

/**
 * `onDidChangeConfiguration` 的订阅者集合。
 * 用法：改 `configValues` 之后 `fireDidChangeConfiguration()`，
 * 于是「配置变更 → 广播」这条链在测试里真的能被触发，而不是只读初值。
 */
export const configurationChangeListeners = new Set<
  (event: { affectsConfiguration(section: string): boolean }) => void
>();

/** 触发一次「readora.* 变了」的事件：affectsConfiguration 一律答真，由测试决定语义。 */
export function fireDidChangeConfiguration(): void {
  const event = { affectsConfiguration: (): boolean => true };
  for (const listener of configurationChangeListeners) {
    listener(event);
  }
}

/**
 * `onDidChangeActiveColorTheme` 的订阅者集合。
 * 用法：改 `window.activeColorTheme.kind` 之后 `fireDidChangeActiveColorTheme()`，
 * 「宿主换主题 → 重新归一 → 是否真的需要打扰 Webview」这条判断才有可测入口。
 */
export const colorThemeChangeListeners = new Set<() => void>();

/** 触发一次宿主颜色主题变化。 */
export function fireDidChangeActiveColorTheme(): void {
  for (const listener of colorThemeChangeListeners) {
    listener();
  }
}

function notFound(path: string): Error {
  return Object.assign(new Error(`EntryNotFound: ${path}`), { code: "FileNotFound" });
}

export const workspace = {
  workspaceFolders: undefined as
    | { uri: Uri; name: string; index: number }[]
    | undefined,
  textDocuments: [] as {
    uri: Uri;
    fileName: string;
    languageId: string;
    version: number;
    isDirty: boolean;
    getText(): string;
  }[],
  fs: {
    stat(uri: Uri): Promise<StubFileStat> {
      statCalls.push(uri.fsPath);
      const stat = fileStates.get(uri.fsPath);
      if (!stat) {
        return Promise.reject(notFound(uri.fsPath));
      }
      return Promise.resolve({ type: stat.type, size: stat.size, mtime: stat.mtime });
    },
    readFile(uri: Uri): Promise<Uint8Array> {
      readFileCalls.push(uri.fsPath);
      const stat = fileStates.get(uri.fsPath);
      if (!stat) {
        return Promise.reject(notFound(uri.fsPath));
      }
      return Promise.resolve(new Uint8Array(stat.size));
    },
    writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      writtenFiles.set(uri.fsPath, content);
      // 写完就能 stat 到：体积与「产物是否存在」的断言共用同一份事实。
      fileStates.set(uri.fsPath, {
        type: FileType.File,
        size: content.byteLength,
        mtime: Date.now()
      });
      return Promise.resolve();
    },
    delete(uri: Uri): Promise<void> {
      deletedFiles.push(uri.fsPath);
      fileStates.delete(uri.fsPath);
      writtenFiles.delete(uri.fsPath);
      return Promise.resolve();
    }
  },
  getConfiguration(section: string): {
    get(key: string): unknown;
    update(key: string, value: unknown, target?: number): Promise<void>;
  } {
    return {
      get(key: string): unknown {
        // 走宿主那套「点号键展开成树」的读法：同名叶与枝的冲突在这里重现，
        // 而不是像扁平 Map 那样把冲突读成「一切正常」。
        return readConfigKey(`${section}.${key}`);
      },
      // config.patch 的落点：写回同一份 configValues，并像真实宿主那样紧跟一次
      // onDidChangeConfiguration，于是「弹层改设置 → 监听 → 广播」在测试里是
      // 真实回路而不是断言口号。
      update(key: string, value: unknown): Promise<void> {
        configValues.set(`${section}.${key}`, value);
        fireDidChangeConfiguration();
        return Promise.resolve();
      }
    };
  },
  onDidChangeConfiguration(
    listener: (event: { affectsConfiguration(section: string): boolean }) => void
  ): StubDisposable {
    configurationChangeListeners.add(listener);
    return {
      dispose(): void {
        configurationChangeListeners.delete(listener);
      }
    };
  },
  onDidChangeTextDocument(listener: unknown): StubDisposable {
    void listener;
    return { dispose(): void {} };
  },
  onDidSaveTextDocument(listener: unknown): StubDisposable {
    void listener;
    return { dispose(): void {} };
  },
  createFileSystemWatcher(): StubDisposable & {
    onDidChange: (listener: unknown) => StubDisposable;
    onDidCreate: (listener: unknown) => StubDisposable;
    onDidDelete: (listener: unknown) => StubDisposable;
  } {
    const noop = (): StubDisposable => ({ dispose(): void {} });
    return {
      dispose(): void {},
      onDidChange: noop,
      onDidCreate: noop,
      onDidDelete: noop
    };
  }
};

export const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();

/**
 * `setContext` 写入的上下文键（VS Code 内部命令）。
 * 键位 `when` 条件依赖它，测试必须能读到最新值才能证明「面板隐藏后快捷键让路」。
 */
export const contextValues = new Map<string, unknown>();

export const commands = {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown): StubDisposable {
    commandHandlers.set(id, handler);
    return {
      dispose(): void {
        commandHandlers.delete(id);
      }
    };
  },
  executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    // setContext(key, value) 不在扩展自己的命令表里，只能在这里落地成可断言的状态。
    if (id === "setContext") {
      const [key, value] = args as [string, unknown];
      contextValues.set(key, value);
      return Promise.resolve(true);
    }
    // vscode.openWith 是宿主内部命令：以指定自定义编辑器打开文档。忠实复刻宿主这一段
    // —— 建一个面板、交给我们注册的 provider（openCustomDocument + resolveCustomEditor），
    // provider 再经 WebviewManager.configure 装配。这样命令路径的面板创建在夹具里可见。
    if (id === "vscode.openWith") {
      const [uri, viewType] = args as [Uri, string];
      const entry = customEditorProviders.find((item) => item.viewType === viewType);
      if (!entry) {
        return Promise.reject(new Error(`no custom editor provider for ${viewType}`));
      }
      const provider = entry.provider as {
        openCustomDocument(uri: Uri, context: unknown, token: unknown): unknown;
        resolveCustomEditor(document: unknown, panel: FakePanel, token: unknown): Promise<void>;
      };
      const panel = window.createWebviewPanel(viewType, "Readora", -1, {});
      const document = provider.openCustomDocument(uri, {}, {});
      return provider.resolveCustomEditor(document, panel, {}).catch((error: unknown) => {
        // 宿主在 resolveCustomEditor 抛错时会关掉这个失败的编辑器：夹具同样把它从记录里
        // 撤下并 dispose，于是「打开不可读文档不留读者面板」这条口径与真机一致。
        const index = createdPanels.indexOf(panel);
        if (index >= 0) {
          createdPanels.splice(index, 1);
        }
        panel.dispose();
        throw error;
      });
    }
    const handler = commandHandlers.get(id);
    return handler
      ? Promise.resolve(handler(...args))
      : Promise.reject(new Error(`command ${id} not found`));
  }
};

export function resetVscodeStub(): void {
  createdPanels.length = 0;
  customEditorProviders.length = 0;
  errorMessages.length = 0;
  warningMessages.length = 0;
  openedExternally.length = 0;
  infoMessages.length = 0;
  infoReply.picked = undefined;
  saveDialog.path = null;
  saveDialog.requests.length = 0;
  outputLines.clear();
  statCalls.length = 0;
  readFileCalls.length = 0;
  writtenFiles.clear();
  deletedFiles.length = 0;
  fileStates.clear();
  configValues.clear();
  ignoredConfigKeys.length = 0;
  commandHandlers.clear();
  contextValues.clear();
  configurationChangeListeners.clear();
  colorThemeChangeListeners.clear();
  workspace.textDocuments.length = 0;
  window.activeTextEditor = undefined;
  window.activeColorTheme = { kind: ColorThemeKind.Dark };
  workspace.workspaceFolders = undefined;
}
