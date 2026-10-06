// The scroll decisions behind "follow live", as pure functions, so node tests cover them. The
// components only measure the DOM and apply what these return.

/** How close to the bottom of the log still counts as "at the bottom", in px. */
export const AT_BOTTOM_PX = 24;

export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export function atBottom(m: ScrollMetrics, slack = AT_BOTTOM_PX): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= slack;
}

/** The log box: it follows the newest row while the viewer is at the bottom. */
export interface LogFollow {
  following: boolean;
  /** Rows that arrived while paused, for "Jump to latest". */
  unseen: number;
}

export const LOG_FOLLOWING: LogFollow = { following: true, unseen: 0 };

export type LogAction =
  /** The viewer scrolled the box (or the box scrolled itself to the bottom). */
  | { type: "scrolled"; atBottom: boolean }
  /** New rows arrived. */
  | { type: "rows"; added: number }
  /** "Jump to latest". */
  | { type: "jump" };

export function logFollow(state: LogFollow, action: LogAction): LogFollow {
  switch (action.type) {
    case "scrolled":
      if (action.atBottom) return LOG_FOLLOWING;
      return state.following ? { following: false, unseen: 0 } : state;
    case "rows":
      return state.following || action.added <= 0
        ? state
        : { ...state, unseen: state.unseen + action.added };
    case "jump":
      return LOG_FOLLOWING;
  }
}

/** A box in page coordinates. */
export interface Box {
  top: number;
  height: number;
}

/**
 * Where to scroll the page so that `target` is in view, or null when it already is. A panel
 * that fits is scrolled the least; one taller than the view shows its top.
 */
export function scrollTargetY(
  target: Box,
  view: { scrollY: number; height: number },
  margin = 16,
): number | null {
  const top = target.top - margin;
  const bottom = target.top + target.height + margin;
  const viewBottom = view.scrollY + view.height;
  if (top >= view.scrollY && bottom <= viewBottom) return null;
  if (bottom - top > view.height || top < view.scrollY) return Math.max(0, top);
  return Math.max(0, bottom - view.height);
}

/** The union of several boxes, e.g. the result and the receipt of one step. */
export function unionBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  const top = Math.min(...boxes.map((b) => b.top));
  const bottom = Math.max(...boxes.map((b) => b.top + b.height));
  return { top, height: bottom - top };
}

/** Keys that scroll the page; pressing one means the viewer took over. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

export function isScrollKey(key: string): boolean {
  return SCROLL_KEYS.has(key);
}

/** Page follow: on by default and for every new run; the viewer's own scrolling pauses it. */
export interface PageFollow {
  on: boolean;
  runId?: string;
}

export type PageAction =
  | { type: "run"; runId: string | undefined }
  | { type: "viewerScrolled" }
  | { type: "toggle" };

export function pageFollow(state: PageFollow, action: PageAction): PageFollow {
  switch (action.type) {
    case "run":
      return action.runId === state.runId ? state : { on: true, runId: action.runId };
    case "viewerScrolled":
      return state.on ? { ...state, on: false } : state;
    case "toggle":
      return { ...state, on: !state.on };
  }
}
