import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

export const addCostParameters = Type.Object({
  amount: Type.Number({ minimum: 0, description: "Additional cost in USD (not cents or a cumulative session total)." }),
  reason: Type.String({ minLength: 1, maxLength: 1000, description: "What incurred this cost, e.g. the bash-launched subagent task or run ID." }),
});

export type AddCostInput = Static<typeof addCostParameters>;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "add_cost",
    label: "Add Cost",
    description:
      "Add an external cost in USD to the current Pi session's native cost total. " +
      "Use after external work such as a subagent launched via bash reports its cost. " +
      "Every successful call adds the amount again; report only the unrecorded cost, never a cumulative total or costs Pi already accounts for. " +
      "This records accounting only: it does not run a subagent or charge money.",
    promptSnippet: "Record external costs in the current session total",
    promptGuidelines: [
      "Use add_cost after bash-launched subagents or other external work report a cost in USD. Do not guess costs or double-count costs already recorded by Pi or a previous add_cost call.",
    ],
    parameters: addCostParameters,
    async execute(_toolCallId, { amount, reason }, signal) {
      signal?.throwIfAborted();
      // Validate here too: tool_call hooks can mutate arguments after schema validation.
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
        throw new Error("amount must be a finite, non-negative cost in USD.");
      }
      if (typeof reason !== "string" || !reason.trim() || reason.length > 1000) {
        throw new Error("reason must be non-blank and at most 1000 characters.");
      }
      const description = reason.trim();
      return {
        content: [{ type: "text", text: `Added $${amount} USD to this session's cost: ${description}` }],
        details: { amount, currency: "USD", reason: description },
        // Pi persists tool-result usage and includes it in footer, /session, and
        // RPC totals, including after compaction. No fabricated token counts or
        // attribution to the parent model's input/output pricing categories.
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: amount },
        },
      };
    },
  });
}
