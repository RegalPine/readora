/**
 * 懒激活观察器（IMP-001 §9.5 / ARC-008 §9.2）。
 *
 * 图片与图表都不该在正文写入的那一刻全量激活：长文档首屏只为视口附近的
 * 元素发资源请求、跑布局。这里把 IntersectionObserver 包成最小接口，
 * 并在没有该 API 的环境（jsdom、无 IntersectionObserver 的旧内核）返回 null，
 * 由调用方退化为「立即激活」—— 于是同一份层代码在真实 Webview 里懒加载，
 * 在单测里保持确定性。
 */

export interface ObserverHandle {
  observe(element: Element): void;
  unobserve(element: Element): void;
  disconnect(): void;
}

export interface ObserverOptions {
  rootMargin: string;
}

export type ObserverFactory = (
  callback: (element: HTMLElement) => void,
  options: ObserverOptions
) => ObserverHandle | null;

export const createLazyObserver: ObserverFactory = (callback, options) => {
  if (typeof IntersectionObserver !== "function") {
    return null;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          callback(entry.target as HTMLElement);
        }
      }
    },
    { rootMargin: options.rootMargin }
  );
  return {
    observe: (element) => {
      observer.observe(element);
    },
    unobserve: (element) => {
      observer.unobserve(element);
    },
    disconnect: () => {
      observer.disconnect();
    }
  };
};
