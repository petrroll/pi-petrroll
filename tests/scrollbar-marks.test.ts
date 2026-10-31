import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachScrollbarMarks,
  findMarks,
  mapToTrack,
  type MarkStyles,
  type ScrollViewLike,
} from "../extensions/scrollbar-marks/marks.ts";

const A = "\x1b]133;A\x07";
const BC = "\x1b]133;B\x07\x1b]133;C\x07";

const styles: MarkStyles = {
  track: (kind) => (kind === "prompt" ? "P" : "R"),
  thumb: (kind) => (kind === "prompt" ? "p" : undefined),
};

class FakeView implements ScrollViewLike {
  readonly primary = true;
  layoutCalls: [number, number][] = [];
  scrollbarTrackStyle = (text: string) => `t${text}`;
  scrollbarThumbStyle = (text: string) => `T${text}`;
  constructor(public lines: string[]) {}
  readonly children = [{ render: (_width: number) => this.lines }];
  updateLayout(contentHeight: number, viewportHeight: number, _requestRender: () => void): void {
    this.layoutCalls.push([contentHeight, viewportHeight]);
  }

  /** Mimic Pi's layout + paint: render content, update layout, then style each track row in order. */
  frame(viewport: number, thumb: [number, number]): string {
    const lines = this.children[0]!.render(80);
    this.updateLayout(lines.length, viewport, () => {});
    let out = "";
    for (let row = 0; row < viewport; row++) {
      out += row >= thumb[0] && row < thumb[1] ? this.scrollbarThumbStyle("┃") : this.scrollbarTrackStyle("│");
    }
    return out;
  }
}

test("findMarks detects OSC 133 zone starts and classifies prompts", () => {
  const lines = [`${A}user`, "body", `${BC}end`, `${A}reply`, "x", `${BC}${A}next prompt`];
  const marks = findMarks(lines, (line) => line.includes("user") || line.includes("prompt"));
  assert.deepEqual(marks, { prompt: [0, 5], reply: [3] });
  assert.deepEqual(findMarks([`${BC}end`, "plain", "\x1b]133;Afake"], () => true), { prompt: [], reply: [] });
});

test("mapToTrack scales rows like an overview ruler and lets prompts win", () => {
  assert.deepEqual(mapToTrack({ prompt: [0, 99], reply: [50] }, 100, 10), [
    "prompt", undefined, undefined, undefined, undefined, "reply", undefined, undefined, undefined, "prompt",
  ]);
  assert.deepEqual(mapToTrack({ prompt: [10], reply: [11] }, 100, 10), [
    undefined, "prompt", undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  ]);
  // Short content maps 1:1 instead of stretching.
  assert.deepEqual(mapToTrack({ prompt: [1], reply: [2] }, 3, 5), [undefined, "prompt", "reply", undefined, undefined]);
  assert.deepEqual(mapToTrack({ prompt: [0], reply: [] }, 0, 3), [undefined, undefined, undefined]);
});

test("attached view paints marks on track and thumb rows, and restores cleanly", () => {
  const lines = Array.from({ length: 40 }, (_, row) => (row === 0 || row === 20 ? `${A}user ${row}` : row === 30 ? `${A}reply` : "text"));
  const view = new FakeView(lines);
  const originalRender = view.children[0]!.render;
  const originalTrack = view.scrollbarTrackStyle;

  const restore = attachScrollbarMarks(view, {
    styles,
    classify: (render) => ({ result: render(), isPrompt: (line) => line.includes("user") }),
  });
  // Rows 0, 20, 30 of 40 map to track rows 0, 5, 7 of 10; thumb covers rows 4-5.
  assert.equal(view.frame(10, [4, 6]), "Pt│t│t│T┃pt│Rt│t│");
  // Counter resets every layout, so repeated frames stay aligned.
  assert.equal(view.frame(10, [0, 2]), "pT┃t│t│t│Pt│Rt│t│");
  assert.deepEqual(view.layoutCalls.at(-1), [40, 10]);

  restore();
  restore();
  assert.equal(view.children[0]!.render, originalRender);
  assert.equal(view.scrollbarTrackStyle, originalTrack);
  assert.ok(!Object.prototype.hasOwnProperty.call(view, "updateLayout"));
  assert.equal(view.frame(4, [0, 1]), "T┃t│t│t│");
});

test("attaching twice replaces the earlier attachment", () => {
  const view = new FakeView([`${A}reply`, "x"]);
  const originalTrack = view.scrollbarTrackStyle;
  const first = attachScrollbarMarks(view, { styles });
  const second = attachScrollbarMarks(view, { styles });
  assert.equal(view.frame(2, [1, 2]), "RT┃");
  assert.equal(view.frame(2, [0, 1]), "T┃t│", "replies under the thumb keep Pi's thumb");
  first();
  assert.equal(view.frame(2, [1, 2]), "RT┃", "stale restore must not undo the newer attachment");
  second();
  assert.equal(view.scrollbarTrackStyle, originalTrack);
});

test("mark styles keep the thumb's width and keep reply marks visible on it", async () => {
  const { createMarkStyles } = await import("../extensions/scrollbar-marks/index.ts");
  const marks = createMarkStyles({ fg: (color, text) => `<${color}>${text}` });
  const pi = (text: string) => `<thumb>${text}`;
  assert.equal(marks.thumb("prompt", "┃", pi), "<accent>╋");
  assert.equal(marks.thumb("reply", "┃", pi), "<thumb>╋");
  assert.equal(marks.thumb("prompt", "█", pi), "<accent>█");
  assert.equal(marks.thumb("reply", "█", pi), "<thumb>█");
});
