import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import cdExtension, { resolveDirectory } from "../extensions/cd/index.ts";

const root = mkdtempSync(join(tmpdir(), "pi-petrroll-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

function fixture({ defaultSessionDir = false } = {}) {
  const dir = mkdtempSync(join(root, "case-"));
  const source = join(dir, "source");
  const target = join(dir, "work tree;literal");
  mkdirSync(source);
  mkdirSync(target);
  // Default: a custom shared session dir, like --session-dir / PI_CODING_AGENT_SESSION_DIR.
  const sessionDir = defaultSessionDir ? undefined : join(dir, "sessions");
  const session = SessionManager.create(source, sessionDir);
  session.appendCustomMessageEntry("fixture", "Conversation to preserve", true);
  // Pi defers initial persistence until an assistant response, so explicitly
  // materialize our synthetic fixture without needing a provider.
  writeFileSync(session.getSessionFile()!, [session.getHeader(), ...session.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const notifications: string[] = [];
  const messages: unknown[] = [];
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const schema = Type.Object({ path: Type.String() });
  let tool!: ToolDefinition<typeof schema>;
  let queued: Promise<void> | undefined;
  let switched: SessionManager | undefined;
  let resumed = false;
  let cancelled = false;
  let switchFinished = false;
  let continuationError: Error | undefined;
  let wait = async () => {};
  const context = {
    cwd: source,
    mode: "tui",
    sessionManager: session,
    ui: { notify: (text: string) => notifications.push(text) },
    waitForIdle: () => wait(),
    switchSession: async (path: string, options: { withSession: (ctx: unknown) => Promise<void> }) => {
      if (cancelled) return { cancelled: true };
      switched = SessionManager.open(path, sessionDir);
      await options.withSession({
        cwd: switched.getCwd(),
        ui: context.ui,
        sendUserMessage: async (_content: string, options: { deliverAs?: string }) => {
          assert.equal(switchFinished, true, "continuation must run after the host finishes switching");
          assert.equal(options?.deliverAs, "followUp");
          if (continuationError) throw continuationError;
          resumed = true;
        },
      });
      switchFinished = true;
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;
  cdExtension({
    registerCommand(name, command) {
      assert.equal(name, "cd");
      handler = command.handler;
    },
    registerTool(definition) { tool = definition as unknown as typeof tool; },
    sendMessage(message) { messages.push(message); },
    sendUserMessage(content, options) {
      assert.equal(options?.expandPromptTemplates, true);
      assert.equal(options?.deliverAs, "followUp");
      assert.equal(typeof content, "string");
      queued = handler((content as string).slice(4), context);
      // Attach a handler immediately, like Pi, while retaining the promise for assertions.
      void queued.catch(() => {});
    },
  } as ExtensionAPI);
  return {
    source, target, session, sessionDir, context, notifications, messages,
    command: (args: string) => handler(args, context),
    execute: (path: string, signal?: AbortSignal) => tool.execute("call-cd", { path }, signal, undefined, context),
    queued: () => queued,
    switched: () => switched,
    resumed: () => resumed,
    cancel: () => { cancelled = true; },
    failContinuation: (error: Error) => { continuationError = error; },
    waitFor: (promise: Promise<void>) => { wait = () => promise; },
  };
}

test("paths: relative, home, quoted spaces, literal shell syntax, symlinks, invalid input", () => {
  const f = fixture();
  assert.equal(resolveDirectory("../work tree;literal", f.source), f.target);
  assert.equal(resolveDirectory(JSON.stringify(f.target), f.source), f.target);
  assert.equal(resolveDirectory(`'${f.target}'`, f.source), f.target);
  assert.equal(resolveDirectory(`@${f.target}`, f.source), f.target);
  assert.equal(resolveDirectory("~", f.source), homedir());
  symlinkSync(f.target, join(f.source, "link"));
  assert.equal(resolveDirectory("link", f.source), f.target);
  writeFileSync(join(f.source, "file"), "not a directory");
  for (const path of ["", "file", "missing", "~someone", "\"bad", "bad\npath"]) {
    assert.throws(() => resolveDirectory(path, f.source));
  }
});

test("/cd copies the full tree, preserves the selected leaf, leaves source unchanged", async () => {
  const f = fixture();
  const selected = f.session.getLeafId()!;
  f.session.appendCustomMessageEntry("fixture", "Other branch", true);
  // Reopen to make fixture persistence behave just like a saved live session.
  writeFileSync(f.session.getSessionFile()!, [f.session.getHeader(), ...f.session.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  f.session.branch(selected);
  const before = readFileSync(f.session.getSessionFile()!, "utf8");
  await f.command(f.target);
  const copy = f.switched()!;
  assert.equal(copy.getCwd(), f.target);
  assert.notEqual(copy.getSessionId(), f.session.getSessionId());
  assert.equal(copy.getHeader()?.parentSession, f.session.getSessionFile());
  assert.equal(copy.getLeafEntry()?.parentId, selected);
  assert.equal(copy.getEntries().length, f.session.getEntries().length + 1);
  assert.equal(readFileSync(f.session.getSessionFile()!, "utf8"), before);
  assert.equal(f.resumed(), false);
  // The copy stays in the shared custom dir so `pi --session <id>` and /resume find it.
  assert.equal(copy.getSessionDir(), f.sessionDir);
  assert.deepEqual((await SessionManager.list(f.target, f.sessionDir)).map((s) => s.path), [copy.getSessionFile()]);
  assert.equal(SessionManager.continueRecent(f.target, f.sessionDir).getSessionId(), copy.getSessionId());
});

test("/cd from a default per-project session dir uses the target's default dir", async () => {
  const f = fixture({ defaultSessionDir: true });
  await f.command(f.target);
  const copy = f.switched()!;
  assert.equal(copy.usesDefaultSessionDir(), true);
  assert.notEqual(copy.getSessionDir(), f.session.getSessionDir());
  assert.deepEqual((await SessionManager.list(f.target)).map((s) => s.path), [copy.getSessionFile()]);
});

test("tool handoff waits for idle and then resumes against the replacement", async () => {
  const f = fixture();
  let settle!: () => void;
  f.waitFor(new Promise<void>((resolve) => { settle = resolve; }));
  const result = await f.execute(f.target);
  assert.equal(result.terminate, true);
  assert.equal(f.switched(), undefined);
  // A tool result arriving after execute must be present in the copy.
  const source = SessionManager.open(f.session.getSessionFile()!);
  source.appendMessage({ role: "toolResult", toolCallId: "call-cd", toolName: "change_directory", content: result.content, isError: false, timestamp: Date.now() });
  settle();
  await f.queued();
  assert.equal(f.switched()?.getCwd(), f.target);
  assert.ok(f.switched()?.getEntries().some((entry) => entry.type === "message" && entry.message.role === "toolResult"));
  assert.equal(f.resumed(), true);
});

test("continuation failure keeps the successful switch and reports recovery on the fresh UI", async () => {
  const f = fixture();
  f.failContinuation(new Error("Provider unavailable"));
  await f.execute(f.target);
  await f.queued();
  assert.equal(f.switched()?.getCwd(), f.target);
  assert.equal(f.resumed(), false);
  assert.match(f.notifications.at(-1)!, /Directory changed, but automatic continuation failed: Provider unavailable/);
  assert.match(f.notifications.at(-1)!, /Send "continue"/);
  assert.equal((await SessionManager.list(f.target, f.sessionDir)).length, 1);
});

test("cancelled tool handoff does not resume", async () => {
  const f = fixture();
  f.cancel();
  await f.execute(f.target);
  await f.queued();
  assert.equal(f.resumed(), false);
  assert.equal(f.switched(), undefined);
  assert.equal((await SessionManager.list(f.target, f.sessionDir)).length, 0);
});

test("rejects concurrent directory changes", async () => {
  const f = fixture();
  let settle!: () => void;
  f.waitFor(new Promise<void>((resolve) => { settle = resolve; }));
  await f.execute(f.target);
  await assert.rejects(f.execute(f.target), /already pending/);
  settle();
  await f.queued();
});

test("invalid target, ephemeral session, and noninteractive mode do not switch", async () => {
  const f = fixture();
  await assert.rejects(f.execute("missing"));
  Object.assign(f.context, { sessionManager: SessionManager.inMemory(f.source) });
  await assert.rejects(f.execute(f.target), /not saved/);
  Object.assign(f.context, { mode: "print", sessionManager: f.session });
  await assert.rejects(f.execute(f.target), /interactive/);
  assert.equal(f.switched(), undefined);
});

test("same-directory calls are a no-op and bare /cd shows usage", async () => {
  const f = fixture();
  await f.command("");
  assert.match(f.notifications[0], /Current directory/);
  await f.command(".");
  const result = await f.execute(".");
  assert.equal(result.terminate, undefined);
  assert.equal(f.switched(), undefined);
  assert.equal(f.queued(), undefined);
});

test("cancellation removes only the new copy", async () => {
  const f = fixture();
  f.cancel();
  await f.command(f.target);
  assert.equal(f.switched(), undefined);
  assert.equal((await SessionManager.list(f.target, f.sessionDir)).length, 0);
  assert.equal(readdirSync(f.session.getSessionDir()).length, 1);
  assert.equal(f.messages.length, 1);
});

test("abort while waiting prevents a switch", async () => {
  const f = fixture();
  const controller = new AbortController();
  let settle!: () => void;
  f.waitFor(new Promise<void>((resolve) => { settle = resolve; }));
  await f.execute(f.target, controller.signal);
  controller.abort();
  settle();
  await assert.rejects(f.queued()!);
  assert.equal(f.switched(), undefined);
});
