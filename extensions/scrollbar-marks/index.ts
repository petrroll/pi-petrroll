import { UserMessageComponent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { attachScrollbarMarks, type AttachOptions, type MarkKind, type MarkStyles, type ScrollViewLike } from "./marks.ts";

const WIDGET_KEY = "pi-petrroll.scrollbar-marks";
const USER_SINK = Symbol.for("pi-petrroll.scrollbar-marks.user-sink");
const USER_PATCHED = Symbol.for("pi-petrroll.scrollbar-marks.user-patched");

type SinkHolder = typeof globalThis & { [USER_SINK]?: Set<string> };

/**
 * Record the first rendered line of every user message while a transcript render is collecting.
 * Installed once per process; it survives `/reload` and only forwards to the current collector.
 */
function patchUserMessages(): boolean {
  const proto = (UserMessageComponent as unknown as { prototype?: Record<PropertyKey, unknown> } | undefined)?.prototype;
  if (!proto || typeof proto.render !== "function") return false;
  if (proto[USER_PATCHED]) return true;
  const original = proto.render as (this: unknown, width: number) => string[];
  proto.render = function (this: unknown, width: number): string[] {
    const lines = original.call(this, width);
    const sink = (globalThis as SinkHolder)[USER_SINK];
    if (sink && lines.length > 0) sink.add(lines[0]!);
    return lines;
  };
  proto[USER_PATCHED] = true;
  return true;
}

const classifyUserMessages: NonNullable<AttachOptions["classify"]> = (render) => {
  const holder = globalThis as SinkHolder;
  const previous = holder[USER_SINK];
  const prompts = new Set<string>();
  holder[USER_SINK] = prompts;
  try {
    return { result: render(), isPrompt: (line) => prompts.has(line) };
  } finally {
    holder[USER_SINK] = previous;
  }
};

type ThemeLike = { fg(color: "accent" | "text", text: string): string };

export function createMarkStyles(theme: ThemeLike): MarkStyles {
  const color = (kind: MarkKind) => (kind === "prompt" ? "accent" : "text");
  return {
    track: (kind) => theme.fg(color(kind), kind === "prompt" ? "━" : "─"),
    // Pi's thumb already uses the text color, so only prompts stand out on it.
    thumb: (kind, glyph) => (kind === "prompt" ? theme.fg("accent", "█") : undefined),
  };
}

function isTranscriptView(value: unknown): value is ScrollViewLike {
  const view = value as Partial<ScrollViewLike> | undefined;
  return (
    !!view &&
    view.primary === true &&
    typeof view.updateLayout === "function" &&
    typeof view.scrollbarTrackStyle === "function" &&
    typeof view.scrollbarThumbStyle === "function" &&
    Array.isArray(view.children) &&
    typeof view.children[0]?.render === "function"
  );
}

function install(ctx: ExtensionContext): void {
  const canClassify = patchUserMessages();
  ctx.ui.setWidget(
    WIDGET_KEY,
    (tui, theme) => {
      let view: ScrollViewLike | undefined;
      let restore: (() => void) | undefined;
      const styles = createMarkStyles(theme);
      return {
        // Renders nothing below the editor. It is only here to see the TUI each frame and attach to
        // the fullscreen transcript once it exists (regular mode has no primary scroll view).
        render(): string[] {
          const candidate = (tui as unknown as { getPrimaryScrollView?: () => unknown }).getPrimaryScrollView?.();
          if (candidate !== view && isTranscriptView(candidate)) {
            restore?.();
            view = candidate;
            restore = attachScrollbarMarks(candidate, {
              styles,
              ...(canClassify ? { classify: classifyUserMessages } : {}),
            });
            tui.requestRender();
          }
          return [];
        },
        invalidate(): void {},
        dispose(): void {
          restore?.();
          restore = undefined;
          view = undefined;
        },
      };
    },
    { placement: "belowEditor" },
  );
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    install(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  });
}
