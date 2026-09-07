import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";

// Exercise actual command dispatch, agent termination, runtime replacement, and
// resource loading without credentials, a terminal, or network/model calls.
test("real Pi runtime: tool handoff persists results, rebuilds cwd and AGENTS.md, then continues", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-petrroll-runtime-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const source = join(root, "source");
  const target = join(root, "worktree");
  const agentDir = join(root, "agent");
  for (const dir of [source, target, agentDir]) mkdirSync(dir);
  writeFileSync(join(source, "AGENTS.md"), "SOURCE_CONTEXT_ONLY");
  writeFileSync(join(target, "AGENTS.md"), "DESTINATION_CONTEXT_ONLY");
  writeFileSync(join(source, "marker.txt"), "source");
  writeFileSync(join(target, "marker.txt"), "destination");
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    modelsStorePath: join(agentDir, "models-store.json"),
    allowModelNetwork: false,
  });
  // A dummy runtime key passes prompt preflight; streamFn below never uses it.
  await modelRuntime.setRuntimeApiKey("anthropic", "test-only-not-a-real-key");
  const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5")!;
  assert.ok(model);
  let requestCount = 0;
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => { finish = resolve; });
  const errors: string[] = [];
  const requests: { cwd: string; systemPrompt: string }[] = [];
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd, agentDir, modelRuntime,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoaderOptions: {
        noExtensions: true,
        additionalExtensionPaths: [resolve("extensions/cd/index.ts")],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      },
    });
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model });
    assert.deepEqual(result.extensionsResult.errors, []);
    modelRuntime.streamSimple = () => {
      requestCount++;
      requests.push({ cwd, systemPrompt: result.session.systemPrompt });
      const message: AssistantMessage = {
        role: "assistant", api: "anthropic-messages", provider: "anthropic", model: model.id,
        content: requestCount === 1
          ? [{ type: "toolCall", id: "switch-call", name: "change_directory", arguments: { path: target } }]
          : [{ type: "text", text: "Continued in the worktree." }],
        stopReason: requestCount === 1 ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
        stream.end(message);
      });
      return stream;
    };
    return { ...result, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: source, agentDir, sessionManager: SessionManager.create(source),
  });
  const bind = async (session: AgentSession) => {
    session.subscribe((event) => {
      if (event.type === "agent_settled" && runtime.cwd === target) finish();
    });
    await session.bindExtensions({
      mode: "tui",
      onError: (error) => { errors.push(error.error); finish(); },
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        switchSession: (path, options) => runtime.switchSession(path, options),
        newSession: (options) => runtime.newSession(options),
        fork: (id, options) => runtime.fork(id, options),
        navigateTree: (id, options) => session.navigateTree(id, options),
        reload: async () => { throw new Error("Unexpected reload"); },
      },
    });
  };
  runtime.setRebindSession(bind);
  try {
    await bind(runtime.session);
    const originalFile = runtime.session.sessionFile!;
    await runtime.session.prompt("Move to the worktree and continue.");
    await Promise.race([
      completed,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`Handoff timed out: ${JSON.stringify({ errors, requests, messages: runtime.session.messages })}`)), 5000);
        completed.then(() => clearTimeout(timer));
      }),
    ]);
    assert.deepEqual(errors, []);
    assert.equal(runtime.cwd, target);
    assert.equal(requestCount, 2, "no additional model call in the source directory");
    assert.match(requests[0].systemPrompt, /SOURCE_CONTEXT_ONLY/);
    assert.match(requests[1].systemPrompt, /DESTINATION_CONTEXT_ONLY/);
    assert.doesNotMatch(requests[1].systemPrompt, /SOURCE_CONTEXT_ONLY/);
    const copiedMessages = runtime.session.sessionManager.buildSessionContext().messages;
    assert.ok(copiedMessages.some((m) => m.role === "toolResult" && m.toolCallId === "switch-call"));
    assert.ok(readFileSync(originalFile, "utf8").includes('"toolResult"'));
    assert.notEqual(runtime.session.sessionFile, originalFile);
    const read = runtime.session.agent.state.tools.find((tool) => tool.name === "read")!;
    const readResult = await read.execute("read-marker", { path: "marker.txt" });
    assert.equal(readResult.content[0].type === "text" && readResult.content[0].text, "destination");
    const bash = runtime.session.agent.state.tools.find((tool) => tool.name === "bash")!;
    const bashResult = await bash.execute("pwd", { command: "pwd" });
    assert.equal(bashResult.content[0].type === "text" && bashResult.content[0].text.trim(), target);
    assert.equal(SessionManager.continueRecent(target).getSessionId(), runtime.session.sessionId);
  } finally {
    await runtime.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});
