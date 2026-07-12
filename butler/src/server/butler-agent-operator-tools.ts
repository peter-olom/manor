import { Type } from "@sinclair/typebox";

import type { ButlerAgentToolAccess, ButlerCustomTool } from "./butler-agent-tool-access.js";

export function buildButlerOperatorTools(access: ButlerAgentToolAccess): ButlerCustomTool[] {
  const optionSchema = Type.Object({
    id: Type.Optional(Type.String()),
    label: Type.String({ minLength: 1 }),
    description: Type.Optional(Type.String())
  });
  const questionSchema = Type.Object({
    prompt: Type.String({ minLength: 1 }),
    context: Type.Optional(Type.String()),
    options: Type.Array(optionSchema, { minItems: 2, maxItems: 6 }),
    allowFreeform: Type.Optional(Type.Boolean())
  });

  return [
    access.defineButlerTool({
      name: "ask_operator",
      label: "Ask operator",
      description: "Ask the operator one to three structured Butler-only questions with selectable options when missing decisions would materially change the work.",
      promptSnippet:
        "ask_operator: Butler-only tool. Use when a product, taste, priority, permission, or irreversible execution choice would materially change the outcome. Always pass a questions array containing 1-3 concise questions, put each recommended option first, and include 2-6 clear options per question. Do not use it for depth selection or questions Butler can resolve safely by inspecting state.",
      parameters: Type.Object({
        questions: Type.Array(questionSchema, { minItems: 1, maxItems: 3 })
      }),
      uiEffects: access.getToolUiEffects("ask_operator"),
      execute: async (_toolCallId, params) => {
        const typedParams = params as {
          questions: Array<{
            prompt: string;
            context?: string;
            options: Array<{ id?: string; label: string; description?: string }>;
            allowFreeform?: boolean;
          }>;
        };
        const message = await access.postOperatorQuestion({
          questions: typedParams.questions
        });
        const questionCount = message.question.questions?.length ?? 1;
        return {
          content: [{ type: "text", text: `Structured operator question card posted with ${questionCount} required answer${questionCount === 1 ? "" : "s"}. Do not send a visible confirmation unless you have substantive context to add.` }],
          details: { question: message.question, message }
        };
      }
    })
  ];
}
