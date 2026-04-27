import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { getJson } from "./api";
import type { ComposerInputItem, ComposerSuggestion } from "./types";

type ActiveToken = {
  trigger: "@" | "$";
  query: string;
  start: number;
  end: number;
};

function findActiveToken(text: string, cursor: number): ActiveToken | null {
  const beforeCursor = text.slice(0, cursor);
  const match = beforeCursor.match(/(^|\s)([@$][^\s]*)$/);
  if (!match || !match[2]) {
    return null;
  }

  const token = match[2];
  const start = beforeCursor.length - token.length;
  return {
    trigger: token[0] as "@" | "$",
    query: token.slice(1),
    start,
    end: cursor
  };
}

function suggestionKindLabel(kind: ComposerSuggestion["kind"]): string {
  switch (kind) {
    case "directory":
      return "Dir";
    case "skill":
      return "Skill";
    case "app":
      return "App";
    case "plugin":
      return "Plugin";
    case "agent":
      return "Agent";
    default:
      return "File";
  }
}

function SuggestionKindIcon({ kind }: { kind: ComposerSuggestion["kind"] }) {
  if (kind === "directory") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M2.5 4.5h4l1 1H13.5v6H2.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="miter" />
      </svg>
    );
  }

  if (kind === "skill") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M4.8 4.8l2.1 2.1M9.1 9.1l2.1 2.1M11.2 4.8 9.1 6.9M6.9 9.1l-2.1 2.1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" />
      </svg>
    );
  }

  if (kind === "app" || kind === "plugin") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M3 3.5h4v4H3zM9 3.5h4v4H9zM3 9.5h4v4H3zM9 9.5h4v4H9z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="miter" />
      </svg>
    );
  }

  if (kind === "agent") {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M8 2.5v2M4.5 6.5h7v5h-7zM6 8.5h.01M10 8.5h.01M6.2 13.5h3.6M2.5 9h2M11.5 9h2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" strokeLinejoin="miter" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M4 2.5h5l3 3v8H4zM8.8 2.8v3h3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="miter" />
    </svg>
  );
}

function suggestionKey(item: ComposerInputItem): string {
  return `${item.type}:${item.path}:${"name" in item ? item.name ?? "" : ""}`;
}

export function ComposerMentions({
  draft,
  textareaRef,
  contextCwd,
  threadId,
  onDraftChange,
  onInputItemsChange,
  onOpenChange
}: {
  draft: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  contextCwd?: string | null;
  threadId?: string | null;
  onDraftChange: (nextDraft: string) => void;
  onInputItemsChange: (items: ComposerInputItem[]) => void;
  onOpenChange?: (isOpen: boolean) => void;
}) {
  const [activeToken, setActiveToken] = useState<ActiveToken | null>(null);
  const [suggestions, setSuggestions] = useState<ComposerSuggestion[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedItems, setSelectedItems] = useState<Array<{ insertText: string; item: ComposerInputItem }>>([]);
  const requestSeqRef = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeTokenRef = useRef<ActiveToken | null>(null);
  const suggestionsRef = useRef<ComposerSuggestion[]>([]);
  const selectedIndexRef = useRef(0);

  useEffect(() => {
    activeTokenRef.current = activeToken;
  }, [activeToken]);

  useEffect(() => {
    suggestionsRef.current = suggestions;
    optionRefs.current.length = suggestions.length;
    setSelectedIndex((current) => (suggestions.length > 0 ? Math.min(current, suggestions.length - 1) : 0));
  }, [suggestions]);

  useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || document.activeElement !== textarea) {
      setActiveToken(null);
      return;
    }
    const nextToken = findActiveToken(draft, textarea.selectionStart ?? draft.length);
    setActiveToken(nextToken);
    setSelectedIndex(0);
    if (listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [draft, textareaRef]);

  useEffect(() => {
    const filtered = selectedItems
      .filter((entry) => draft.includes(entry.insertText))
      .filter((entry, index, entries) => entries.findIndex((candidate) => suggestionKey(candidate.item) === suggestionKey(entry.item)) === index);
    onInputItemsChange(filtered.map((entry) => entry.item));
    if (filtered.length !== selectedItems.length) {
      setSelectedItems(filtered);
    }
  }, [draft, onInputItemsChange, selectedItems]);

  useEffect(() => {
    if (!activeToken) {
      setSuggestions([]);
      return;
    }

    const requestId = requestSeqRef.current + 1;
    requestSeqRef.current = requestId;
    const params = new URLSearchParams({
      trigger: activeToken.trigger,
      q: activeToken.query
    });
    if (contextCwd) {
      params.set("cwd", contextCwd);
    }
    if (threadId) {
      params.set("threadId", threadId);
    }

    const timeoutId = window.setTimeout(() => {
      void getJson<{ suggestions: ComposerSuggestion[] }>(`/api/composer/suggestions?${params.toString()}`)
        .then((payload) => {
          if (requestSeqRef.current === requestId) {
            const nextSuggestions = payload.suggestions ?? [];
            setSuggestions(nextSuggestions);
            setSelectedIndex(0);
            if (listRef.current) {
              listRef.current.scrollTop = 0;
            }
          }
        })
        .catch(() => {
          if (requestSeqRef.current === requestId) {
            setSuggestions([]);
          }
        });
    }, 120);

    return () => window.clearTimeout(timeoutId);
  }, [activeToken, contextCwd, threadId]);

  const insertSuggestion = useCallback(
    (suggestion: ComposerSuggestion) => {
      const textarea = textareaRef.current;
      const token = activeTokenRef.current;
      if (!textarea || !token) {
        return;
      }

      const nextDraft = `${draft.slice(0, token.start)}${suggestion.insertText} ${draft.slice(token.end)}`;
      onDraftChange(nextDraft);
      if (suggestion.inputItem) {
        setSelectedItems((current) => [
          ...current.filter((entry) => suggestionKey(entry.item) !== suggestionKey(suggestion.inputItem!)),
          { insertText: suggestion.insertText, item: suggestion.inputItem! }
        ]);
      }

      setActiveToken(null);
      setSuggestions([]);
      window.requestAnimationFrame(() => {
        const nextCursor = token.start + suggestion.insertText.length + 1;
        textarea.focus();
        textarea.setSelectionRange(nextCursor, nextCursor);
      });
    },
    [draft, onDraftChange, textareaRef]
  );

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      const currentSuggestions = suggestionsRef.current;
      if (!activeTokenRef.current || currentSuggestions.length === 0) {
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((current) => (current + 1) % currentSuggestions.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((current) => (current - 1 + currentSuggestions.length) % currentSuggestions.length);
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insertSuggestion(currentSuggestions[selectedIndexRef.current] ?? currentSuggestions[0]!);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setActiveToken(null);
        setSuggestions([]);
      }
    };

    textarea.addEventListener("keydown", handleKeyDown);
    return () => textarea.removeEventListener("keydown", handleKeyDown);
  }, [insertSuggestion, textareaRef]);

  useLayoutEffect(() => {
    if (!activeToken || suggestions.length === 0) {
      return;
    }

    const list = listRef.current;
    const option = optionRefs.current[selectedIndex];
    if (!list || !option) {
      return;
    }

    const optionTop = option.offsetTop;
    const optionBottom = optionTop + option.offsetHeight;
    const visibleTop = list.scrollTop;
    const visibleBottom = visibleTop + list.clientHeight;

    if (optionTop < visibleTop) {
      list.scrollTop = optionTop;
    } else if (optionBottom > visibleBottom) {
      list.scrollTop = optionBottom - list.clientHeight;
    }
  }, [activeToken, selectedIndex, suggestions.length]);

  const isOpen = activeToken !== null && suggestions.length > 0;

  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  if (!isOpen) {
    return null;
  }

  return (
    <div ref={listRef} className="composer-suggestions" role="listbox" aria-label="Composer suggestions">
      {suggestions.map((suggestion, index) => (
        <button
          key={suggestion.id}
          ref={(element) => {
            optionRefs.current[index] = element;
          }}
          type="button"
          className={`composer-suggestion${index === selectedIndex ? " is-active" : ""}`}
          onMouseDown={(event) => {
            event.preventDefault();
            insertSuggestion(suggestion);
          }}
          role="option"
          aria-selected={index === selectedIndex}
        >
          <span className={`composer-suggestion-kind is-${suggestion.kind}`} title={suggestionKindLabel(suggestion.kind)}>
            <SuggestionKindIcon kind={suggestion.kind} />
            <span className="sr-only">{suggestionKindLabel(suggestion.kind)}</span>
          </span>
          <span className="composer-suggestion-copy">
            <span className="composer-suggestion-label">{suggestion.label}</span>
            {suggestion.detail ? <span className="composer-suggestion-detail">{suggestion.detail}</span> : null}
          </span>
        </button>
      ))}
    </div>
  );
}

export function ignoreComposerSuggestionEnter(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
  const key = event.key;
  return key === "ArrowDown" || key === "ArrowUp" || key === "Tab" || key === "Escape";
}
