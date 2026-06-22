import { useCallback, useMemo, useRef, useState } from "react";

type VirtualWindowOptions = {
  count: number;
  rowHeight: number;
  overscan?: number;
};

export function useVirtualWindow({ count, rowHeight, overscan = 6 }: VirtualWindowOptions) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(1);

  const onScroll = useCallback(() => {
    const element = viewportRef.current;
    if (!element) return;
    setScrollTop(element.scrollTop);
    setViewportHeight(element.clientHeight || 1);
  }, []);

  const window = useMemo(() => {
    const visibleStart = Math.floor(scrollTop / rowHeight);
    const visibleCount = Math.ceil(viewportHeight / rowHeight);
    const start = Math.max(0, visibleStart - overscan);
    const end = Math.min(count, visibleStart + visibleCount + overscan);
    return {
      start,
      end,
      totalHeight: count * rowHeight,
      offsetTop: start * rowHeight
    };
  }, [count, overscan, rowHeight, scrollTop, viewportHeight]);

  return {
    viewportRef,
    onScroll,
    ...window
  };
}
