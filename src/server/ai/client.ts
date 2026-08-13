import Anthropic from "@anthropic-ai/sdk";

/** The model the assistant runs on. */
export const ASSISTANT_MODEL = "claude-opus-5";

let cached: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (cached) return cached;
  // The SDK resolves ANTHROPIC_API_KEY (or an OAuth profile) itself.
  cached = new Anthropic();
  return cached;
}

/** True when the assistant can actually run. Everything else works without it. */
export function assistantConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}
