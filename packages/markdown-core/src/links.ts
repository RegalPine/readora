/**
 * 链接分类（ARC-002 §7.6 / ARC-008 §8.2）。
 *
 * 只有 http/https 链接交给 Host 打开；文档内锚点本地滚动；
 * 相对路径与其余 scheme 不得由 Webview 拼接成本地路径（IMP-001 §12.2），
 * 因此既不生成 href，也不发起任何请求。
 */
export type LinkKind = "anchor" | "external" | "relative" | "blocked";

export interface LinkClassification {
  kind: LinkKind;
  href: string;
}

const ANCHOR = /^#/;
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;

export function classifyLink(href: string | undefined): LinkClassification {
  const value = (href ?? "").trim();
  if (value === "") {
    return { kind: "blocked", href: "" };
  }
  if (ANCHOR.test(value)) {
    return { kind: "anchor", href: value.slice(1) };
  }
  if (WINDOWS_DRIVE.test(value)) {
    return { kind: "blocked", href: value };
  }
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    // 无法按绝对 URL 解析 → 相对路径（跨文档跳转，待 M3 资源解析）
    return { kind: "relative", href: value };
  }
  const protocol = url.protocol.toLowerCase();
  if (protocol === "http:" || protocol === "https:") {
    return { kind: "external", href: url.toString() };
  }
  return { kind: "blocked", href: url.toString() };
}

/** 图片 src 同样不做本地解析，仅标注来源类别（ARC-008 §8.1 默认不加载远程图片）。 */
export type ImageKind = "remote" | "local";

export function classifyImageSrc(src: string | undefined): ImageKind {
  const value = (src ?? "").trim();
  if (/^https?:\/\//i.test(value) || /^\/\//.test(value)) {
    return "remote";
  }
  return "local";
}
