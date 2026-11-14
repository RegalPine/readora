/**
 * 待投递暂存区（ARC-004 §8.7 reader.ready 门控）。
 *
 * document.load 在面板创建后只暂存、不发送；收到 reader.ready 后
 * 取出即删并投递。纯数据结构，不依赖 vscode，可独立单测
 * （AUD-001 §13.5 首屏空白事故的结构性防线）。
 */
export class PendingDeliveries<T> {
  private readonly items = new Map<string, T>();

  stage(key: string, item: T): void {
    this.items.set(key, item);
  }

  /** 取出即删：同一份载荷只投递一次。 */
  deliver(key: string): T | undefined {
    const item = this.items.get(key);
    this.items.delete(key);
    return item;
  }

  peek(key: string): T | undefined {
    return this.items.get(key);
  }

  discard(key: string): void {
    this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
  }

  get size(): number {
    return this.items.size;
  }
}