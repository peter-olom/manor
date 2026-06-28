import { useCallback, useEffect, useRef, useState } from "react";

const PIN_THRESHOLD_PX = 64;

type AnchoredScrollOptions = {
  bottomKey: unknown;
  resetKey?: unknown;
};

export function useAnchoredScroll<T extends HTMLElement>({ bottomKey, resetKey }: AnchoredScrollOptions) {
  const ref = useRef<T | null>(null);
  const [isPinned, setIsPinned] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const pendingUnread = useRef(0);
  const rafHandle = useRef<number | null>(null);
  const lastBottomKey = useRef<unknown>(bottomKey);
  const pinnedRef = useRef(true);

  useEffect(() => {
    pinnedRef.current = isPinned;
  }, [isPinned]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const element = ref.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
  }, []);

  const onScroll = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const nextPinned = distanceFromBottom <= PIN_THRESHOLD_PX;
    if (nextPinned !== pinnedRef.current) {
      pinnedRef.current = nextPinned;
      setIsPinned(nextPinned);
    }
    if (nextPinned) {
      pendingUnread.current = 0;
      setUnreadCount(0);
    }
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (bottomKey !== lastBottomKey.current) {
      lastBottomKey.current = bottomKey;
      pendingUnread.current = 0;
      setUnreadCount(0);
      if (pinnedRef.current) {
        if (rafHandle.current !== null) cancelAnimationFrame(rafHandle.current);
        rafHandle.current = requestAnimationFrame(() => {
          rafHandle.current = null;
          element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
        });
      } else {
        pendingUnread.current += 1;
        setUnreadCount(pendingUnread.current);
      }
    }
  }, [bottomKey]);

  useEffect(() => {
    const element = ref.current;
    if (!element || resetKey === undefined) return;
    pendingUnread.current = 0;
    setUnreadCount(0);
    pinnedRef.current = true;
    setIsPinned(true);
    if (rafHandle.current !== null) cancelAnimationFrame(rafHandle.current);
    rafHandle.current = requestAnimationFrame(() => {
      rafHandle.current = null;
      element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
    });
  }, [resetKey]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) {
        element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
      }
    });
    observer.observe(element);
    for (const child of Array.from(element.children)) {
      observer.observe(child);
    }
    const mutationObserver = new MutationObserver(() => {
      if (pinnedRef.current) {
        if (rafHandle.current !== null) return;
        rafHandle.current = requestAnimationFrame(() => {
          rafHandle.current = null;
          element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
        });
      }
    });
    mutationObserver.observe(element, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      mutationObserver.disconnect();
      if (rafHandle.current !== null) cancelAnimationFrame(rafHandle.current);
    };
  }, []);

  return { ref, onScroll, isPinned, unreadCount, scrollToBottom };
}
