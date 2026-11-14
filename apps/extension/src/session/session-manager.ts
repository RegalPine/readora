/**
 * 阅读会话管理（ARC-004 §7.2：一个文档一个面板，复用不重复创建）。
 *
 * 会话以 documentUri 为键；阅读状态在会话内保持（ARC-007 §8），
 * 跨会话记忆属 F05-008（P1），不在 M1 范围。
 *
 * M4 起会话还持有视图状态（ARC-004 §6.2 ReaderSessionState 的子集：
 * focusMode / outlineVisible / contentWidth）。它与阅读状态一样只活在会话里：
 * 面板释放即弃，不写用户设置，也不进 `state.save` 载荷（ARC-007 §10.1/§10.3）。
 */
import type * as vscode from "vscode";
import {
  CONTENT_WIDTH_MAX,
  CONTENT_WIDTH_MIN,
  type ReaderPreferences,
  type ReadingState,
  type ViewStatePayload
} from "@readora/contracts";

/** 宽度增减命令的单次步进（ARC-004 §4.5「内容宽度增减」键位）。 */
export const CONTENT_WIDTH_STEP = 80;

export interface ReaderSession {
  readonly id: string;
  readonly documentUri: string;
  panel: vscode.WebviewPanel | null;
  /** 最近一次投递的文档版本；-1 表示尚未投递。 */
  documentVersion: number;
  readingState: ReadingState | null;
  /** 会话视图状态；面板创建前为 null（初值需要偏好参与）。 */
  viewState: ViewStatePayload | null;
  isDisposed: boolean;
  readonly createdAt: number;
}

/** 宽度落在 [CONTENT_WIDTH_MIN, CONTENT_WIDTH_MAX]，非整数向下取整。 */
export function clampContentWidth(value: number): number {
  if (Number.isNaN(value)) {
    return CONTENT_WIDTH_MIN;
  }
  const integer = Math.trunc(value);
  // 比较式写法顺带管住 ±Infinity：放大到顶、收缩到底，而不是回落成「最小」。
  if (integer > CONTENT_WIDTH_MAX) {
    return CONTENT_WIDTH_MAX;
  }
  if (integer < CONTENT_WIDTH_MIN) {
    return CONTENT_WIDTH_MIN;
  }
  return integer;
}

export class SessionManager {
  private readonly sessions = new Map<string, ReaderSession>();
  private counter = 0;

  getOrCreate(documentUri: string): { session: ReaderSession; created: boolean } {
    const existing = this.sessions.get(documentUri);
    if (existing && !existing.isDisposed) {
      return { session: existing, created: false };
    }
    this.counter += 1;
    const session: ReaderSession = {
      id: `session-${this.counter.toString(36)}`,
      documentUri,
      panel: null,
      documentVersion: -1,
      readingState: null,
      viewState: null,
      isDisposed: false,
      createdAt: Date.now()
    };
    this.sessions.set(documentUri, session);
    return { session, created: true };
  }

  get(documentUri: string): ReaderSession | undefined {
    const session = this.sessions.get(documentUri);
    return session && !session.isDisposed ? session : undefined;
  }

  getById(id: string): ReaderSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.id === id && !session.isDisposed) {
        return session;
      }
    }
    return undefined;
  }

  all(): ReaderSession[] {
    return [...this.sessions.values()].filter((session) => !session.isDisposed);
  }

  /** refresh 命令在无活动 Markdown 编辑器时的回退目标。 */
  mostRecent(): ReaderSession | undefined {
    let latest: ReaderSession | undefined;
    for (const session of this.all()) {
      if (!latest || session.createdAt > latest.createdAt) {
        latest = session;
      }
    }
    return latest;
  }

  /**
   * 命令目标会话：优先当前可见的面板，全部隐藏时回退到最近创建的会话
   * （ARC-004 §4.1 第 3 条的同一口径：命令不打扰用户，但也不空转）。
   */
  activeSession(): ReaderSession | undefined {
    for (const session of this.all()) {
      if (session.panel?.visible) {
        return session;
      }
    }
    return this.mostRecent();
  }

  /** 视图状态初值：outlineVisible 取 showOutline，宽度取同名偏好（ARC-004 §6.2）。 */
  initializeViewState(
    sessionId: string,
    preferences: ReaderPreferences
  ): ViewStatePayload | null {
    const session = this.getById(sessionId);
    if (!session) {
      return null;
    }
    session.viewState = {
      focusMode: false,
      outlineVisible: preferences.showOutline,
      contentWidth: clampContentWidth(preferences.contentWidth)
    };
    return session.viewState;
  }

  viewStateOf(sessionId: string): ViewStatePayload | null {
    return this.getById(sessionId)?.viewState ?? null;
  }

  /**
   * 合并补丁并返回合并结果；宽度在此收口到契约区间，
   * 于是「命令参数被写坏」最多让宽度顶到边界，不会投出非法载荷。
   */
  patchViewState(
    sessionId: string,
    patch: Partial<ViewStatePayload>
  ): ViewStatePayload | null {
    const session = this.getById(sessionId);
    const current = session?.viewState;
    if (!session || !current) {
      return null;
    }
    session.viewState = {
      focusMode: patch.focusMode ?? current.focusMode,
      outlineVisible: patch.outlineVisible ?? current.outlineVisible,
      contentWidth:
        patch.contentWidth === undefined
          ? current.contentWidth
          : clampContentWidth(patch.contentWidth)
    };
    return session.viewState;
  }

  /** 宽度增减：步进与边界都在会话层，命令层只表达方向（±1）。 */
  stepContentWidth(sessionId: string, direction: number): ViewStatePayload | null {
    const current = this.viewStateOf(sessionId);
    if (!current) {
      return null;
    }
    const step = direction < 0 ? -CONTENT_WIDTH_STEP : CONTENT_WIDTH_STEP;
    return this.patchViewState(sessionId, {
      contentWidth: clampContentWidth(current.contentWidth + step)
    });
  }

  /** 幂等：panel.onDidDispose 与主动关闭都会走到这里。 */
  disposeSession(session: ReaderSession): void {
    if (session.isDisposed) {
      return;
    }
    session.isDisposed = true;
    this.sessions.delete(session.documentUri);
    const panel = session.panel;
    session.panel = null;
    panel?.dispose();
  }

  dispose(): void {
    for (const session of [...this.sessions.values()]) {
      this.disposeSession(session);
    }
  }
}