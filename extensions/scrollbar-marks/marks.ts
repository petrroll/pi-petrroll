/**
 * Scrollbar marks for Pi's fullscreen transcript.
 *
 * Pi paints the transcript scrollbar one row at a time, top to bottom, calling the ScrollView's
 * `scrollbarTrackStyle` or `scrollbarThumbStyle` once per row right after layout. This module wraps
 * those callbacks on one ScrollView instance (plus its content render and `updateLayout`) so each
 * row can show whether a prompt or reply starts in the corresponding part of the transcript.
 * Everything is instance-level and fully reversible; no Pi module is modified.
 */

export type MarkKind = "prompt" | "reply";

/** Rendered message starts carry an OSC 133 prompt-zone start, possibly after other zone markers. */
const ZONE_START = /^(?:\x1b\]133;[BC](?:\x07|\x1b\\))*\x1b\]133;A(?:\x07|\x1b\\)/;

export interface MarkStyles {
  /** Track cell (outside the thumb) for a row containing a mark. */
  track(kind: MarkKind): string;
  /** Thumb cell for a row containing a mark; receives Pi's thumb glyph. Return undefined to keep Pi's thumb. */
  thumb(kind: MarkKind, glyph: string): string | undefined;
}

/** Minimal structural view of `@earendil-works/pi-tui`'s ScrollView that this module relies on. */
export interface ScrollViewLike {
  readonly primary: boolean;
  readonly children: { render(width: number): string[] }[];
  scrollbarTrackStyle: (text: string) => string;
  scrollbarThumbStyle: (text: string) => string;
  updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void;
}

/** Content rows where prompts and replies start, in transcript order. */
export interface ContentMarks {
  prompt: number[];
  reply: number[];
}

/**
 * Find message starts in rendered transcript lines.
 * `isPrompt(line)` decides whether a zone-start line belongs to a user prompt; others are replies.
 */
export function findMarks(lines: readonly string[], isPrompt: (line: string) => boolean): ContentMarks {
  const marks: ContentMarks = { prompt: [], reply: [] };
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row]!;
    if (!ZONE_START.test(line)) continue;
    (isPrompt(line) ? marks.prompt : marks.reply).push(row);
  }
  return marks;
}

/**
 * Map content rows onto scrollbar rows, like an overview ruler: row `r` of `contentHeight` lands on
 * track row `floor(r * trackHeight / contentHeight)`. Prompts win over replies on shared rows.
 */
export function mapToTrack(marks: ContentMarks, contentHeight: number, trackHeight: number): (MarkKind | undefined)[] {
  const track: (MarkKind | undefined)[] = new Array(Math.max(0, trackHeight)).fill(undefined);
  if (contentHeight <= 0 || trackHeight <= 0) return track;
  const scale = Math.min(1, trackHeight / contentHeight);
  const place = (row: number, kind: MarkKind) => {
    const index = Math.min(trackHeight - 1, Math.floor(row * scale));
    if (index >= 0 && track[index] !== "prompt") track[index] = kind;
  };
  for (const row of marks.reply) place(row, "reply");
  for (const row of marks.prompt) place(row, "prompt");
  return track;
}

export interface AttachOptions {
  styles: MarkStyles;
  /**
   * Run the transcript render and report which zone-start lines are prompts.
   * Defaults to treating every zone start as a reply.
   */
  classify?: <T>(render: () => T) => { result: T; isPrompt: (line: string) => boolean };
}

const ATTACHED = Symbol.for("pi-petrroll.scrollbar-marks.attached");

/** Install marks on a ScrollView. Returns an idempotent function that restores the original behavior. */
export function attachScrollbarMarks(view: ScrollViewLike, options: AttachOptions): () => void {
  const target = view as ScrollViewLike & { [ATTACHED]?: () => void };
  target[ATTACHED]?.();

  const child = view.children[0];
  if (!child) return () => {};

  const originalTrack = view.scrollbarTrackStyle;
  const originalThumb = view.scrollbarThumbStyle;
  const hadOwnUpdateLayout = Object.prototype.hasOwnProperty.call(view, "updateLayout");
  const originalUpdateLayout = view.updateLayout;
  const hadOwnRender = Object.prototype.hasOwnProperty.call(child, "render");
  const originalRender = child.render;
  const classify = options.classify ?? ((render) => ({ result: render(), isPrompt: () => false }));

  let marks: ContentMarks = { prompt: [], reply: [] };
  let track: (MarkKind | undefined)[] = [];
  let row = 0;

  child.render = function (this: unknown, width: number): string[] {
    const { result, isPrompt } = classify(() => originalRender.call(child, width));
    marks = findMarks(result, isPrompt);
    return result;
  };

  view.updateLayout = function (this: unknown, contentHeight, viewportHeight, requestRender) {
    originalUpdateLayout.call(view, contentHeight, viewportHeight, requestRender);
    track = mapToTrack(marks, contentHeight, viewportHeight);
    row = 0;
  };

  view.scrollbarTrackStyle = (text) => {
    const kind = track[row++];
    return kind ? options.styles.track(kind) : originalTrack(text);
  };
  view.scrollbarThumbStyle = (text) => {
    const kind = track[row++];
    return (kind && options.styles.thumb(kind, text)) ?? originalThumb(text);
  };

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    view.scrollbarTrackStyle = originalTrack;
    view.scrollbarThumbStyle = originalThumb;
    if (hadOwnUpdateLayout) view.updateLayout = originalUpdateLayout;
    else delete (view as Partial<ScrollViewLike>).updateLayout;
    if (hadOwnRender) child.render = originalRender;
    else delete (child as Partial<typeof child>).render;
    if (target[ATTACHED] === restore) delete target[ATTACHED];
  };
  target[ATTACHED] = restore;
  return restore;
}
