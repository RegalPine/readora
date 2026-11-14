/**
 * 文档内搜索浮层（ARC-007 §9.1 / PRD-002 §10.2、§10.3，STORY-07-03）。
 *
 * 面板只做「输入 → 防抖 → 调引擎 → 呈现计数」，匹配与高亮全在 search-engine：
 * - 输入防抖 250ms（PRD-002 §10.3），不随每个按键扫一遍正文；
 * - 计数 `n / m`，无结果显式提示 No matches（§12「搜索无结果 → 展示无匹配结果」）；
 * - 上/下一个循环导航，Enter / Shift+Enter / ↑ / ↓ 等价（§10.3）；
 * - Escape 关闭并清除临时高亮，焦点归还正文（§10.3 末条）；
 * - 文档版本一变即丢弃旧结果（§9.4 第 3 条），重新搜索前先还原上一轮高亮（§13）。
 *
 * 非 modal：`role="search"` 浮层不抢焦点循环，图表与正文交互照常可用。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import {
  SEARCH_HIT_ID_ATTRIBUTE,
  activateMatch,
  applyHighlights,
  clearHighlights,
  formatMatchCount,
  searchInDocument,
  type SearchMatch
} from "./search-engine";

export const SEARCH_PANEL_CLASS = "readora-search-panel";
/** 输入防抖：PRD-002 §10.3 明确 250ms。 */
export const SEARCH_DEBOUNCE_MS = 250;
export const NO_MATCH_LABEL = "No matches";

export interface SearchPanelProps {
  /** 搜索作用域：当前文档正文容器（§9.4「限定当前文档」）。 */
  getRoot(): HTMLElement | null;
  documentId: string;
  documentVersion: number;
  onClose(): void;
}

interface SearchSnapshot {
  matches: SearchMatch[];
  activeIndex: number;
  /** 已经在 DOM 上留下高亮的那次查询，用于判断结果是否过期。 */
  executedQuery: string;
}

const EMPTY_SNAPSHOT: SearchSnapshot = {
  matches: [],
  activeIndex: -1,
  executedQuery: ""
};

export function SearchPanel({
  getRoot,
  documentId,
  documentVersion,
  onClose
}: SearchPanelProps) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [snapshot, setSnapshot] = useState<SearchSnapshot>(EMPTY_SNAPSHOT);
  const inputRef = useRef<HTMLInputElement>(null);
  // 高亮落在哪个容器上必须记下来：卸载或关闭时清的是那一个，不是「现在的」。
  const highlightedRef = useRef<HTMLElement | null>(null);

  const run = useCallback(
    (value: string): void => {
      const root = getRoot();
      if (!root) {
        highlightedRef.current = null;
        setSnapshot(EMPTY_SNAPSHOT);
        return;
      }
      // 每次重新搜索前先还原上一轮：不叠加、不重复构建整份文档（§13）。
      if (highlightedRef.current && highlightedRef.current !== root) {
        clearHighlights(highlightedRef.current);
      }
      clearHighlights(root);
      const outcome = searchInDocument(
        root,
        { query: value, caseSensitive },
        documentVersion,
        documentId
      );
      const matches = outcome.result.matches;
      if (matches.length > 0) {
        applyHighlights(root, outcome, documentVersion);
      }
      highlightedRef.current = root;
      setSnapshot({
        matches,
        activeIndex: matches.length > 0 ? 0 : -1,
        executedQuery: value
      });
    },
    [caseSensitive, documentId, documentVersion, getRoot]
  );

  // 输入防抖 + 大小写切换 + 文档版本变化都走同一条重搜路径。
  useEffect(() => {
    const timer = setTimeout(() => {
      run(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [query, run]);

  // 活动命中：先清旧的 active 标记，再定位到当前项（§9.1「点击结果定位」）。
  useEffect(() => {
    const current = snapshot.matches[snapshot.activeIndex];
    if (!current) {
      return;
    }
    const root = getRoot();
    if (root) {
      activateMatch(root, current.id);
    }
  }, [getRoot, snapshot]);

  // 打开即聚焦输入框，打字不用先点一下（PRD-002 §10.2）。
  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    input.select();
  }, []);

  // 卸载即还原：临时高亮不属于文档（§9.4「高亮不得破坏原始 DOM 结构」）。
  useEffect(
    () => () => {
      const root = highlightedRef.current;
      if (root) {
        clearHighlights(root);
        highlightedRef.current = null;
      }
    },
    []
  );

  // 点击正文里的命中项即把它设为当前项。
  useEffect(() => {
    const root = getRoot();
    if (!root) {
      return;
    }
    const onClick = (event: MouseEvent): void => {
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>(`[${SEARCH_HIT_ID_ATTRIBUTE}]`)
          : null;
      if (!target) {
        return;
      }
      const id = target.getAttribute(SEARCH_HIT_ID_ATTRIBUTE);
      const index = snapshot.matches.findIndex((match) => match.id === id);
      if (index >= 0) {
        setSnapshot((current) =>
          current.activeIndex === index ? current : { ...current, activeIndex: index }
        );
      }
    };
    root.addEventListener("click", onClick);
    return () => {
      root.removeEventListener("click", onClick);
    };
  }, [getRoot, snapshot.matches]);

  const step = useCallback((delta: number): void => {
    setSnapshot((current) => {
      if (current.matches.length === 0) {
        return current;
      }
      // 首尾相接：读完最后一个再按「下一个」回到第一个。
      const next =
        (current.activeIndex + delta + current.matches.length) % current.matches.length;
      return current.activeIndex === next ? current : { ...current, activeIndex: next };
    });
  }, []);

  const close = useCallback((): void => {
    const root = highlightedRef.current;
    if (root) {
      clearHighlights(root);
      highlightedRef.current = null;
    }
    // 焦点归还正文：容器临时可聚焦，键盘用户不至于掉回 <body>（PRD-002 §10.3）。
    const target = getRoot();
    if (target) {
      target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
    }
    onClose();
  }, [getRoot, onClose]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      step(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      step(-1);
      return;
    }
    if (event.key === "Escape") {
      // 面板持有焦点时 Escape 归搜索自己，且不再往上冒（优先级见 useSearchShortcuts）。
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };

  const total = snapshot.matches.length;
  const typing = query.trim().length > 0;
  // 防抖窗口里结果还对应着上一次查询，此时不报「No matches」，只留空。
  const settled = snapshot.executedQuery === query;
  const count =
    total === 0
      ? typing && settled
        ? NO_MATCH_LABEL
        : ""
      : `${snapshot.activeIndex + 1} / ${formatMatchCount(total)}`;

  return (
    <div
      className={SEARCH_PANEL_CLASS}
      role="search"
      aria-label="Search in document"
      onKeyDown={onKeyDown}
    >
      <input
        ref={inputRef}
        className="readora-search-input"
        type="text"
        aria-label="Search text"
        placeholder="Search in document"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
        }}
      />
      <span className="readora-search-count" role="status" aria-live="polite">
        {count}
      </span>
      <button
        type="button"
        className="readora-search-tool"
        aria-pressed={caseSensitive}
        title="Match case"
        onClick={() => {
          setCaseSensitive((current) => !current);
        }}
      >
        Aa
      </button>
      <button
        type="button"
        className="readora-search-tool"
        aria-label="Previous match"
        disabled={total === 0}
        onClick={() => {
          step(-1);
        }}
      >
        ↑
      </button>
      <button
        type="button"
        className="readora-search-tool"
        aria-label="Next match"
        disabled={total === 0}
        onClick={() => {
          step(1);
        }}
      >
        ↓
      </button>
      <button
        type="button"
        className="readora-search-tool"
        aria-label="Close search"
        onClick={close}
      >
        ×
      </button>
    </div>
  );
}
