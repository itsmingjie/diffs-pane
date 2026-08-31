/**
 * Measure the character offset within a rendered code line for a pointer
 * position. Walks the line's text nodes and binary-searches character rects,
 * so it stays correct with syntax token spans, tabs, and wrapped lines.
 */
export function characterAtPoint(lineElement: HTMLElement, x: number, y: number): number {
  const walker = document.createTreeWalker(lineElement, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (length === 0) continue;
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (y > rect.bottom || (y >= rect.top && x > rect.right)) {
      offset += length;
      continue;
    }
    if (y < rect.top || x < rect.left) return offset;
    let low = 0;
    let high = length;
    while (low < high) {
      const middle = (low + high) >> 1;
      range.setStart(node, middle);
      range.setEnd(node, middle + 1);
      const charRect = range.getBoundingClientRect();
      const after =
        y > charRect.bottom || (y >= charRect.top && x > (charRect.left + charRect.right) / 2);
      if (after) low = middle + 1;
      else high = middle;
    }
    return offset + low;
  }
  return offset;
}
