import { describe, expect, it } from "vitest";
import {
  atBottom,
  isScrollKey,
  LOG_FOLLOWING,
  logFollow,
  pageFollow,
  scrollTargetY,
  unionBox,
} from "./follow";

describe("the log box", () => {
  it("counts a few pixels from the end as the bottom", () => {
    expect(atBottom({ scrollTop: 680, clientHeight: 300, scrollHeight: 1000 })).toBe(true);
    expect(atBottom({ scrollTop: 600, clientHeight: 300, scrollHeight: 1000 })).toBe(false);
    // A box with nothing to scroll is at the bottom.
    expect(atBottom({ scrollTop: 0, clientHeight: 300, scrollHeight: 120 })).toBe(true);
  });

  it("follows new rows until the viewer scrolls up, counts what they miss, and resumes", () => {
    let s = LOG_FOLLOWING;
    s = logFollow(s, { type: "rows", added: 3 });
    expect(s).toEqual({ following: true, unseen: 0 });
    s = logFollow(s, { type: "scrolled", atBottom: false });
    expect(s).toEqual({ following: false, unseen: 0 });
    s = logFollow(s, { type: "rows", added: 2 });
    s = logFollow(s, { type: "rows", added: 1 });
    expect(s).toEqual({ following: false, unseen: 3 });
    // Scrolling around while paused keeps the count.
    expect(logFollow(s, { type: "scrolled", atBottom: false })).toBe(s);
    expect(logFollow(s, { type: "jump" })).toEqual(LOG_FOLLOWING);
    // Scrolling back down by hand resumes too.
    expect(logFollow(s, { type: "scrolled", atBottom: true })).toEqual(LOG_FOLLOWING);
  });
});

describe("following the page", () => {
  const view = { scrollY: 1000, height: 800 };

  it("leaves a panel that is already in view alone", () => {
    expect(scrollTargetY({ top: 1100, height: 300 }, view)).toBeNull();
  });

  it("scrolls the least to bring a panel below or above into view", () => {
    // Below: its bottom lands at the bottom of the view, with the margin.
    expect(scrollTargetY({ top: 1700, height: 300 }, view)).toBe(1700 + 300 + 16 - 800);
    // Above: its top lands at the top.
    expect(scrollTargetY({ top: 500, height: 200 }, view)).toBe(500 - 16);
  });

  it("shows the top of a panel taller than the view", () => {
    expect(scrollTargetY({ top: 1500, height: 1200 }, view)).toBe(1500 - 16);
    expect(scrollTargetY({ top: 8, height: 1200 }, { scrollY: 300, height: 800 })).toBe(0);
  });

  it("joins the boxes of one step", () => {
    expect(
      unionBox([
        { top: 1200, height: 400 },
        { top: 1620, height: 300 },
      ]),
    ).toEqual({ top: 1200, height: 720 });
    expect(unionBox([])).toBeNull();
  });

  it("pauses when the viewer scrolls, and comes back with a new run or the toggle", () => {
    let s = pageFollow({ on: true }, { type: "run", runId: "r1" });
    expect(s).toEqual({ on: true, runId: "r1" });
    s = pageFollow(s, { type: "viewerScrolled" });
    expect(s.on).toBe(false);
    // The same run again changes nothing; a new run turns it back on.
    expect(pageFollow(s, { type: "run", runId: "r1" }).on).toBe(false);
    expect(pageFollow(s, { type: "run", runId: "r2" })).toEqual({ on: true, runId: "r2" });
    expect(pageFollow(s, { type: "toggle" }).on).toBe(true);
  });

  it("treats the keys that scroll a page as the viewer taking over", () => {
    for (const key of ["PageDown", "ArrowUp", " ", "End"]) expect(isScrollKey(key)).toBe(true);
    for (const key of ["a", "Enter", "Tab"]) expect(isScrollKey(key)).toBe(false);
  });
});
