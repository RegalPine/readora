/**
 * 资产内联（M11 · 导出链路）。
 *
 * 「单文件自包含」在这里落地：样式表里的 `url()` 与正文里的 `<img>` 都换成
 * `data:`，交付物离开本机也一定能原样打开。两条通道的失败语义刻意不同：
 *
 * - **字体：fail-closed。** 读不到任何一个 `url()` 引用就整体报错、不出交付物。
 *   半内联的产物是「前三段是衬线、后三段突然变系统字」，用户没法判断是自己
 *   没装字体还是导出坏了；口径与 `woff2Only` 一致 —— 样式表每个 `url()` 都
 *   必须在归档内解析得出。
 * - **图片：逐张尽力，失败保持屏上形态。** 引用被策略拒绝、文件缺失或超限，
 *   在屏上本来就是占位卡 / 失败卡，交付物里就继续是那张卡（`img` 不带 `src`）。
 *   把一张图读不到升级成整次导出失败，等于让交付物比屏幕更脆弱。
 *
 * 本模块不 import vscode：字节从注入的读取器来，读字节那条闸门复用
 * `ResourceService.readInline`（同一套策略、同一个 `maxImageSizeMb`）。
 */
import { READORA_ERROR_CODES } from "@readora/contracts";
import { ReaderError } from "../errors";

/**
 * 已构建产物里的引用形态：`./xxx.woff2`，与资产文件同名同目录。
 * 字符集不含 `/`，因此 `../x.woff2`、`sub/x.woff2` 都落不进来（它们不是同目录）。
 */
const ASSET_REFERENCE = /^(?:\.\/)?([\w.+-]+)$/u;
/** `url()` 的四种写法都要认：裸的、单引号、双引号、内含空白。 */
const CSS_URL_REFERENCE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*))\s*\)/gu;
const MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  [".woff2", "font/woff2"],
  [".woff", "font/woff"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".svg", "image/svg+xml"]
]);

/** 内联后的图片字节：只有 MIME 与 base64，路径不出 Host。 */
export interface InlinePayload {
  readonly mimeType: string;
  readonly base64: string;
}

/**
 * 资产字节：与 `ResourceService.readInline` 同一分工 —— 端口只给字节与时间戳，
 * `data:` 的拼法与缓存判据留在本模块，否则这些规则会有一份藏在不被覆盖率
 * 分母收录的 vscode 端口里。
 */
export interface AssetBytes {
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly mtimeMs: number;
}

/** 资产读取器：`dist/webview/assets/` 内的同名文件；不存在返回 null。 */
export type AssetReader = (name: string) => Promise<AssetBytes | null>;

/** 图片读取器：按文档内原始引用走资源策略；不给读 / 读不到返回 null。 */
export type ImageReferenceReader = (reference: string) => Promise<InlinePayload | null>;

/**
 * 进程内字体缓存：键是资产名。
 *
 * 只按 `size` + `mtimeMs` 判新旧（与 ResourceService 的缓存同一判据）：`dist/` 下
 * 的构建产物在一次会话里基本不变，而重开面板重跑一次导出是最常见路径，
 * 27 个 woff2 的 base64 每次都重算会明显让导出变慢。
 */
const assetCache = new Map<string, { size: number; mtimeMs: number; dataUrl: string }>();

/** 仅供测试与热重载：丢弃全部已编码资产。 */
export function clearAssetCache(): void {
  assetCache.clear();
}

function mimeForAsset(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot === -1 ? "" : name.slice(dot).toLowerCase();
  const mimeType = MIME_BY_EXTENSION.get(extension);
  if (mimeType === undefined) {
    throw new ReaderError(
      READORA_ERROR_CODES.EXPORT_FAILED,
      `Export cannot inline the stylesheet reference "${name}": unsupported asset type.`
    );
  }
  return mimeType;
}

/** MIME 只在字符集受限时才允许写进 `data:`，防止读回来的类型串带出结构。 */
function safeMimeType(value: string): string {
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu.test(value) ? value : "application/octet-stream";
}

/**
 * 把样式表里的每个 `url()` 换成 `data:`。
 *
 * 引用必须能落到归档内的同名资产：`data:` 原样保留（已经是自包含形态），
 * `http(s)` 与任何非「同目录单个文件名」的形态都算内联失败 —— 交付物里留着
 * 一条远端引用，就等于把「离线可开」的承诺悄悄换掉了。
 *
 * 两轮扫描是有意分开：第一轮只收集名字并并发无关地逐个解析（fail-closed 就
 * 在这一轮发生），第二轮一次 `replace` 完成替换。于引用写法（裸、单引号、
 * 双引号）都走同一个出口，不会出现「识别到了但没替掉」的残留。
 */
export async function inlineCssAssets(
  cssText: string,
  readAsset: AssetReader
): Promise<string> {
  const names = new Set<string>();
  for (const match of cssText.matchAll(CSS_URL_REFERENCE)) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (raw === "" || raw.startsWith("data:")) {
      continue;
    }
    const assetName = ASSET_REFERENCE.exec(raw)?.[1];
    if (assetName === undefined) {
      throw new ReaderError(
        READORA_ERROR_CODES.EXPORT_FAILED,
        `Export cannot inline the stylesheet reference "${raw}": only same-directory assets are supported.`
      );
    }
    names.add(assetName);
  }
  if (names.size === 0) {
    return cssText;
  }
  const resolved = new Map<string, string>();
  for (const name of names) {
    resolved.set(name, await readAssetDataUrl(name, readAsset));
  }
  return cssText.replace(
    CSS_URL_REFERENCE,
    (whole: string, quoted: string | undefined, singleQuoted: string | undefined, bare: string | undefined) => {
      const raw = (quoted ?? singleQuoted ?? bare ?? "").trim();
      const assetName = ASSET_REFERENCE.exec(raw)?.[1];
      if (assetName === undefined) {
        return whole;
      }
      return `url(${resolved.get(assetName)})`;
    }
  );
}

async function readAssetDataUrl(name: string, readAsset: AssetReader): Promise<string> {
  const cached = assetCache.get(name);
  const asset = await readAsset(name);
  if (asset === null) {
    throw new ReaderError(
      READORA_ERROR_CODES.EXPORT_FAILED,
      `Export cannot inline the stylesheet asset "./${name}": it is not readable.`
    );
  }
  if (cached && cached.size === asset.size && cached.mtimeMs === asset.mtimeMs) {
    return cached.dataUrl;
  }
  const dataUrl = `data:${mimeForAsset(name)};base64,${Buffer.from(asset.bytes).toString("base64")}`;
  assetCache.set(name, { size: asset.size, mtimeMs: asset.mtimeMs, dataUrl });
  return dataUrl;
}

/** 序列化层保留的图片状态：这两态在屏上就没有像素，导出也不补 `src`。 */
const UNRESOLVED_IMAGE_STATES = new Set(["blocked", "missing"]);

const IMAGE_STATE_PATTERN = /\bdata-readora-image-state="([^"]*)"/u;
/**
 * 包裹层标签：只按 `data-readora-image` 认，值里的 `"` 已由 DOM 序列化转义成
 * `&quot;`，因此属性值内不会出现裸引号，`[^"]*` 是安全的。
 */
const IMAGE_WRAPPER_TAG = /<[a-zA-Z][^>]*\bdata-readora-image="([^"]*)"[^>]*>/gu;
const IMAGE_TAG = /<img\b[^>]*>/iu;

export interface ImageInlineResult {
  readonly html: string;
  /** 补上 `data:` 的张数。 */
  readonly inlined: number;
  /** 保持占位形态的张数（策略拒绝、读不到、blocked/missing）。 */
  readonly skipped: number;
}

function decodeReference(value: string): string {
  return value
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

/**
 * 正文里的图片内联。
 *
 * 这里没有 DOM（Host 侧不引 jsdom，见 Rejected Alternatives），因此按标签扫描
 * 配对：每个带 `data-readora-image` 的包裹标签，其后**第一个** `<img` 属于它，
 * 且必须在下一次出现包裹标签之前 —— 与屏上「一个包裹一张图」的结构同源
 * （`image-layer.ts` 的 `ELEMENT_SELECTOR`）。找不到就不改，绝不跨包裹乱补。
 *
 * `src` 是追加而不是替换：序列化层已摘掉屏上那份 `vscode-webview://` 的地址，
 * 交付物里出现的所有 `src` 都只能是这里的 `data:`。
 */
export async function inlineImages(
  bodyHtml: string,
  readImage: ImageReferenceReader
): Promise<ImageInlineResult> {
  const wrappers: { index: number; end: number; reference: string; state: string }[] = [];
  for (const match of bodyHtml.matchAll(IMAGE_WRAPPER_TAG)) {
    const index = match.index ?? 0;
    wrappers.push({
      index,
      end: index + match[0].length,
      reference: decodeReference(match[1] ?? ""),
      state: IMAGE_STATE_PATTERN.exec(match[0])?.[1] ?? ""
    });
  }
  if (wrappers.length === 0) {
    return { html: bodyHtml, inlined: 0, skipped: 0 };
  }

  let html = "";
  let cursor = 0;
  let inlined = 0;
  let skipped = 0;
  for (const [position, wrapper] of wrappers.entries()) {
    const next = wrappers[position + 1];
    const boundary = next === undefined ? bodyHtml.length : next.index;
    const segment = bodyHtml.slice(wrapper.end, boundary);
    html += bodyHtml.slice(cursor, wrapper.end);
    cursor = boundary;
    if (
      UNRESOLVED_IMAGE_STATES.has(wrapper.state) ||
      wrapper.reference === "" ||
      wrapper.reference.startsWith("data:")
    ) {
      html += segment;
      skipped += 1;
      continue;
    }
    const payload = await readImage(wrapper.reference);
    // 拒绝与读不到都落回占位形态：屏上什么样，文件里就什么样。
    if (payload === null) {
      html += segment;
      skipped += 1;
      continue;
    }
    const tag = IMAGE_TAG.exec(segment)?.[0];
    if (tag === undefined) {
      html += segment;
      skipped += 1;
      continue;
    }
    const dataUrl = `data:${safeMimeType(payload.mimeType)};base64,${payload.base64}`;
    const selfClosing = tag.endsWith("/>");
    const injected = selfClosing
      ? `${tag.slice(0, -2)} src="${dataUrl}" />`
      : `${tag.slice(0, -1)} src="${dataUrl}">`;
    html += segment.replace(tag, injected);
    inlined += 1;
  }
  html += bodyHtml.slice(cursor);
  return { html, inlined, skipped };
}
