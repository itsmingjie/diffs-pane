interface CaretDocument extends Document {
  caretPositionFromPoint?(
    x: number,
    y: number,
    options?: { shadowRoots?: ShadowRoot[] },
  ): { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?(x: number, y: number): Range | null;
}

/** Return the character offset within a rendered code line at a pointer position. */
export function characterAtPoint(lineElement: HTMLElement, x: number, y: number): number {
  const owner = lineElement.ownerDocument as CaretDocument;
  const root = lineElement.getRootNode();
  const position = owner.caretPositionFromPoint?.(x, y, {
    shadowRoots: root instanceof ShadowRoot ? [root] : undefined,
  });
  const range = owner.caretRangeFromPoint?.(x, y);
  const node = position?.offsetNode ?? range?.startContainer;
  const offset = position?.offset ?? range?.startOffset;
  if (node === undefined || offset === undefined) return 0;
  if (node !== lineElement && !lineElement.contains(node)) return 0;

  const prefix = owner.createRange();
  prefix.selectNodeContents(lineElement);
  prefix.setEnd(node, offset);
  return prefix.toString().length;
}
