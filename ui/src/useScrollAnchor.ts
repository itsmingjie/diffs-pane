import type { CodeViewItem } from '@pierre/diffs';
import { useStableCallback, type CodeViewHandle } from '@pierre/diffs/react';
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const ANCHOR_WINDOW_MS = 5000;

interface ScrollAnchor {
  id?: string;
  offset: number;
  scrollTop: number;
  patchHash: string;
  waitForPatch: boolean;
  until: number;
}

export function useScrollAnchor<T>(
  viewerRef: RefObject<CodeViewHandle<T> | null>,
  items: readonly CodeViewItem<T>[],
  patchHash: string,
) {
  const anchorRef = useRef<ScrollAnchor | null>(null);

  const capture = useStableCallback((waitForPatch: boolean) => {
    const instance = viewerRef.current?.getInstance();
    if (!instance) return;

    const scrollTop = instance.getScrollTop();
    let id: string | undefined;
    let itemTop: number | undefined;
    for (const item of items) {
      const top = instance.getTopForItem(item.id);
      if (top === undefined || top > scrollTop || (itemTop !== undefined && top <= itemTop)) continue;
      id = item.id;
      itemTop = top;
    }
    anchorRef.current = {
      id,
      offset: itemTop === undefined ? Number.NaN : scrollTop - itemTop,
      scrollTop,
      patchHash,
      waitForPatch,
      until: Date.now() + ANCHOR_WINDOW_MS,
    };
  });

  const restore = useStableCallback(() => {
    const anchor = anchorRef.current;
    const instance = viewerRef.current?.getInstance();
    if (!anchor || !instance) return;
    const itemTop =
      anchor.id === undefined || Number.isNaN(anchor.offset)
        ? undefined
        : instance.getTopForItem(anchor.id);
    const position = itemTop === undefined ? anchor.scrollTop : itemTop + anchor.offset;
    if (Math.abs(instance.getScrollTop() - position) >= 1) {
      instance.scrollTo({ type: 'position', position, behavior: 'instant' });
    }
  });

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    if (Date.now() > anchor.until) {
      anchorRef.current = null;
      return;
    }

    restore();
    const patchArrived = anchor.waitForPatch && patchHash !== anchor.patchHash;
    const frame = requestAnimationFrame(() => {
      restore();
      if (!anchor.waitForPatch || patchArrived) anchorRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [items, patchHash, restore]);

  useEffect(() => {
    const release = () => {
      anchorRef.current = null;
    };
    window.addEventListener('wheel', release, { passive: true });
    window.addEventListener('touchmove', release, { passive: true });
    return () => {
      window.removeEventListener('wheel', release);
      window.removeEventListener('touchmove', release);
    };
  }, []);

  return capture;
}
