import { existsSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** The entire argument is a path, not a shell expression. */
export function resolveDirectory(argument: string, cwd: string): string {
  let path = argument.trim();
  if (path.startsWith('"')) {
    path = JSON.parse(path) as string;
    if (typeof path !== "string") throw new Error("Expected a directory path.");
  } else if (path.startsWith("'") && path.endsWith("'")) {
    path = path.slice(1, -1);
  }
  if (!path || /[\x00-\x1f\x7f]/.test(path)) {
    throw new Error("Provide a non-empty directory path without control characters.");
  }
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = resolve(homedir(), path.slice(2));
  else if (path.startsWith("~")) throw new Error("Use ~ or ~/path, not ~username.");
  const target = realpathSync(resolve(cwd, path));
  if (!statSync(target).isDirectory()) throw new Error(`Not a directory: ${target}`);
  return target;
}

function requireSavedSession(ctx: ExtensionContext): string {
  // Interactive mode owns the asynchronous command handoff and runtime rebinding.
  if (ctx.mode !== "tui") throw new Error("Changing directory currently requires interactive Pi.");
  const file = ctx.sessionManager.getSessionFile();
  if (!file || !existsSync(file)) {
    throw new Error("This session is not saved yet. Send a message first; --no-session is not supported.");
  }
  return file;
}

/**
 * Where the copied session should live. A custom session dir (--session-dir,
 * PI_CODING_AGENT_SESSION_DIR, or the sessionDir setting) is shared across
 * projects and must be kept; otherwise resume/listing in that dir cannot find
 * the copy. The default dir is per-cwd, so the copy gets the target's default.
 */
export function targetSessionDir(sessionManager: ExtensionContext["sessionManager"]): string | undefined {
  // The live object is a full SessionManager; ReadonlySessionManager just does
  // not expose this predicate in its type.
  const usesDefault = (sessionManager as { usesDefaultSessionDir?: () => boolean }).usesDefaultSessionDir;
  if (typeof usesDefault !== "function" || usesDefault.call(sessionManager)) return undefined;
  return sessionManager.getSessionDir();
}

export default function cdExtension(pi: ExtensionAPI) {
  let busy = false;
  let toolRequest: { argument: string; signal: AbortSignal | undefined } | undefined;

  pi.registerCommand("cd", {
    description: "Copy this session into another directory and switch there: /cd <path>",
    handler: async (args, ctx) => {
      const request = toolRequest?.argument === args ? toolRequest : undefined;
      if (request) toolRequest = undefined;
      if (busy) throw new Error("A directory change is already pending.");
      if (!args.trim()) {
        ctx.ui.notify(`Current directory: ${ctx.cwd}\nUsage: /cd <path>`, "info");
        return;
      }
      busy = true;
      try {
        // Commands dispatch immediately, even with deliverAs: followUp. Waiting
        // here (never inside tool.execute) lets all tool results reach disk first.
        await ctx.waitForIdle();
        request?.signal?.throwIfAborted();
        const source = requireSavedSession(ctx);
        const target = resolveDirectory(args, ctx.cwd);
        if (target === realpathSync(ctx.cwd)) {
          ctx.ui.notify(`Already in ${target}`, "info");
          return;
        }

        const copy = SessionManager.forkFrom(source, target, targetSessionDir(ctx.sessionManager));
        // forkFrom copies the whole tree but opens its last entry. Preserve the
        // actual selected leaf, including when the user navigated with /tree.
        const leaf = ctx.sessionManager.getLeafId();
        if (leaf) copy.branch(leaf);
        else copy.resetLeaf();
        copy.appendCustomMessageEntry(
          "pi-petrroll:cd",
          `Working directory changed from ${ctx.cwd} to ${target}. ` +
            "Relative paths now refer to the new directory. Follow the newly loaded project instructions.",
          true,
          { from: ctx.cwd, to: target, parentSession: source },
        );
        const destination = copy.getSessionFile()!;
        let resume: (() => Promise<void>) | undefined;
        const result = await ctx.switchSession(destination, {
          withSession: async (fresh) => {
            fresh.ui.notify(`Changed directory to ${fresh.cwd}`, "info");
            if (request) {
              // Capture only the fresh context, not the invalidated pi/ctx.
              resume = async () => {
                try {
                  await fresh.sendUserMessage(
                    "The requested directory change has completed. Continue the outstanding task in this directory. " +
                      "If no work remains, briefly confirm the change.",
                    { deliverAs: "followUp" },
                  );
                } catch (error) {
                  fresh.ui.notify(
                    `Directory changed, but automatic continuation failed: ${error instanceof Error ? error.message : String(error)}. ` +
                      'Send "continue" to resume.',
                    "warning",
                  );
                }
              };
            }
          },
        });
        if (result.cancelled) {
          unlinkSync(destination);
          pi.sendMessage({
            customType: "pi-petrroll:cd",
            content: "Directory change cancelled. The original session and working directory are unchanged.",
            display: true,
          });
          ctx.ui.notify("Directory change cancelled.", "warning");
          return;
        }
        // sendUserMessage awaits the entire agent run. Do not run it inside
        // withSession: the host must finish switching first, and prompt errors
        // must not be treated as fatal failures to replace the runtime.
        await resume?.();
      } finally {
        // Local state only; session-bound pi/ctx may now be stale.
        busy = false;
      }
    },
  });

  pi.registerTool({
    name: "change_directory",
    label: "Change directory",
    description:
      "Copy the current saved session into an existing directory and switch Pi there, reloading tools and project context. " +
      "Interactive mode only. The switch happens after the current run settles, then work resumes automatically. " +
      "Create any git worktree with bash first. Call this tool alone, not in parallel with other tools; do not do more work in the old directory afterward.",
    promptSnippet: "Switch Pi to another project/worktree while keeping conversation history",
    promptGuidelines: [
      "Use change_directory to move Pi into a newly created worktree or another project; bash cd does not change Pi's working directory.",
      "Call change_directory alone and let its handoff finish before doing further work.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Existing directory: absolute, relative to Pi's cwd, or ~/path" }),
    }),
    async execute(_id, { path }, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (busy || toolRequest) throw new Error("A directory change is already pending.");
      requireSavedSession(ctx);
      const target = resolveDirectory(JSON.stringify(path), ctx.cwd);
      if (target === realpathSync(ctx.cwd)) {
        return { content: [{ type: "text", text: `Already in ${target}.` }], details: { cwd: target } };
      }
      const argument = JSON.stringify(target);
      toolRequest = { argument, signal };
      // Explicit expansion is essential: otherwise /cd is sent as text to the LLM.
      pi.sendUserMessage(`/cd ${argument}`, { deliverAs: "followUp", expandPromptTemplates: true });
      return {
        content: [{
          type: "text",
          text: `Directory change to ${target} requested, not completed yet. End this run now; work will resume automatically after switching.`,
        }],
        details: { target, status: "pending" },
        terminate: true,
      };
    },
  });
}
