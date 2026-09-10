import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import costExtension, { addCostParameters, type AddCostInput } from "../extensions/cost/index.ts";

function toolFixture() {
  let tool!: ToolDefinition<typeof addCostParameters>;
  costExtension({
    registerTool(definition) { tool = definition as unknown as typeof tool; },
  } as ExtensionAPI);
  return {
    tool,
    execute: (input: AddCostInput, signal?: AbortSignal) =>
      tool.execute("add-cost-test", input, signal, undefined, {} as ExtensionContext),
  };
}

test("add_cost returns native cost-only usage and an audit reason", async () => {
  const { tool, execute } = toolFixture();
  assert.equal(tool.name, "add_cost");
  assert.ok(tool.promptGuidelines?.every((line) => line.includes("add_cost")));
  for (const amount of [0, 0.000001, 0.125, 12.3456789]) {
    const result = await execute({ amount, reason: "  bash subagent run-123  " });
    assert.deepEqual(result.usage, {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: amount },
    });
    assert.deepEqual(result.details, { amount, currency: "USD", reason: "bash subagent run-123" });
    assert.match(result.content[0].type === "text" ? result.content[0].text : "", /Added \$.* USD/);
  }
});

test("add_cost rejects invalid amounts, reasons, and cancelled calls", async () => {
  const { execute } = toolFixture();
  // Exercise runtime validation as well as the schema (hooks can mutate args).
  for (const amount of [-1, NaN, Infinity, -Infinity, "0.25", null, undefined]) {
    await assert.rejects(execute({ amount, reason: "subagent" } as AddCostInput), /finite, non-negative/);
  }
  for (const reason of ["", " \n\t", "x".repeat(1001), null, undefined, 42]) {
    await assert.rejects(execute({ amount: 0.25, reason } as AddCostInput), /reason must/);
  }
  await assert.rejects(execute({ amount: 0.25, reason: "subagent" }, AbortSignal.abort()), { name: "AbortError" });
});

test("real Pi: costs accumulate, persist, survive compaction and resume, and don't add tokens", { timeout: 20_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-petrroll-cost-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const sessions: AgentSession[] = [];
  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
    await modelRuntime.setRuntimeApiKey("anthropic", "test-only-not-a-real-key");
    const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5")!;
    assert.ok(model);
    const open = async (sessionManager: SessionManager) => {
      const services = await createAgentSessionServices({
        cwd: root, agentDir, modelRuntime,
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
        resourceLoaderOptions: {
          noExtensions: true,
          additionalExtensionPaths: [resolve("extensions/cost/index.ts")],
          noSkills: true, noPromptTemplates: true, noThemes: true,
        },
      });
      const result = await createAgentSessionFromServices({ services, sessionManager, model });
      sessions.push(result.session);
      assert.deepEqual(result.extensionsResult.errors, []);
      await result.session.bindExtensions({ mode: "json" });
      return result.session;
    };
    let requests = 0;
    modelRuntime.streamSimple = () => {
      requests++;
      const message: AssistantMessage = {
        role: "assistant", api: "anthropic-messages", provider: "anthropic", model: model.id,
        content: requests === 1 ? [
          { type: "toolCall", id: "cost-1", name: "add_cost", arguments: { amount: 0.125, reason: "subagent A" } },
          { type: "toolCall", id: "cost-2", name: "add_cost", arguments: { amount: 0.25, reason: "subagent B" } },
          { type: "toolCall", id: "invalid", name: "add_cost", arguments: { amount: -100, reason: "invalid" } },
        ] : [{ type: "text", text: "Costs recorded." }],
        stopReason: requests === 1 ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0.125, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.125 },
        },
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "toolUse" | "stop", message });
        stream.end(message);
      });
      return stream;
    };
    const session = await open(SessionManager.create(root, join(root, "sessions")));
    assert.match(session.systemPrompt, /Use add_cost after bash-launched subagents/);
    await session.prompt("Record the costs reported by two external subagents.");
    assert.equal(requests, 2);
    assert.equal(session.getSessionStats().cost, 0.625);
    assert.equal(session.getSessionStats().tokens.total, 4);
    const results = session.messages.filter((m) => m.role === "toolResult");
    assert.equal(results.length, 3);
    assert.deepEqual(results.map((m) => m.usage?.cost.total), [0.125, 0.25, undefined]);
    assert.equal(results[2].isError, true);

    // A compaction checkpoint removes the tool results from model context, but
    // Pi's native billed totals still include the original session entries.
    const leaf = session.sessionManager.getLeafId()!;
    session.sessionManager.appendCompaction("Summary", leaf, 4);
    assert.equal(session.getSessionStats().cost, 0.625);
    assert.ok(!session.sessionManager.buildSessionContext().messages.some((m) => m.role === "toolResult"));
    const file = session.sessionFile!;
    session.dispose();
    sessions.pop();
    const resumed = await open(SessionManager.open(file));
    assert.equal(resumed.getSessionStats().cost, 0.625);
    assert.equal(resumed.getSessionStats().tokens.total, 4);
    const recorded = resumed.sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "toolResult" && e.message.usage);
    assert.equal(recorded.length, 2);
    const fresh = await open(SessionManager.inMemory(root));
    assert.equal(fresh.getSessionStats().cost, 0);
  } finally {
    for (const session of sessions) session.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  }
});
