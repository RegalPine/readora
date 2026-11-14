/**
 * 链接放行策略（ARC-004 §8.7 护栏 / ARC-008）。
 *
 * document.open 只允许 http/https 交给 OS 打开；
 * file://、vscode://、javascript: 等一律拒绝。纯函数，可独立单测。
 */

export type LinkDecision =
  | { allowed: true; uri: string }
  | { allowed: false; reason: string };

export function decideLinkOpen(raw: string): LinkDecision {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, reason: "Link is not a valid absolute URL." };
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    return { allowed: true, uri: url.toString() };
  }
  return {
    allowed: false,
    reason: `Link scheme "${url.protocol}" is not allowed; only http/https are permitted.`
  };
}