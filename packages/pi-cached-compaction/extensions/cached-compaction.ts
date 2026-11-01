import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";

const CODEX_COMPACTION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const { preparation, signal, customInstructions } = event;
    const model = ctx.model;

    // Let Pi's built-in compaction handle cases where no model is available or
    // the custom summary request fails.
    if (!model) return;

    const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
    const conversation = serializeConversation(convertToLlm(messages));
    const previousSummary = preparation.previousSummary
      ? `<previous-summary>\n${preparation.previousSummary}\n</previous-summary>\n\n`
      : "";
    const extraFocus = customInstructions
      ? `\n\nAdditional user-provided focus:\n${customInstructions}`
      : "";
    const prompt = `${previousSummary}<conversation>\n${conversation}\n</conversation>\n\n${CODEX_COMPACTION_PROMPT}${extraFocus}`;
    const maxTokens = Math.min(
      Math.floor(0.8 * preparation.settings.reserveTokens),
      model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
    );

    try {
      const response = await ctx.modelRegistry.complete(
        model,
        {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          maxTokens,
          signal,
          cacheRetention: "none",
          sessionId: uuidv7(),
        },
      );

      if (response.stopReason === "error" || response.stopReason === "length" || response.stopReason === "aborted") {
        return;
      }

      const summary = response.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      // Do not persist empty or tool-calling responses; fall back to Pi's normal summarizer.
      if (!summary || response.content.some((block) => block.type === "toolCall")) return;

      const modifiedFiles = [...new Set([...preparation.fileOps.written, ...preparation.fileOps.edited])].sort();
      const modified = new Set(modifiedFiles);
      const readFiles = [...preparation.fileOps.read].filter((path) => !modified.has(path)).sort();
      let summaryWithFiles = summary;
      if (readFiles.length > 0) {
        summaryWithFiles += `\n\n<read-files>\n${readFiles.join("\n")}\n</read-files>`;
      }
      if (modifiedFiles.length > 0) {
        summaryWithFiles += `\n\n<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`;
      }

      return {
        compaction: {
          summary: summaryWithFiles,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage: response.usage,
          details: { readFiles, modifiedFiles },
        },
      };
    } catch {
      // Keep compaction resilient: the built-in prompt is used if this call fails.
      return;
    }
  });
}
