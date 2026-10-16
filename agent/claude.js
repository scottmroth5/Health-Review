// The review's Claude client: agent-core's createClaude (cached system prompt, structured output,
// stop_reason checks, cost, tracing) with server-side refusal fallbacks on models that support them,
// so a declined request is retried on a fallback model in the same call (agent-core sends it to the
// beta endpoint when betas are given).
import { createClaude } from '@scottmroth5/agent-core';

export const DEFAULT_REVIEW_MODEL = 'claude-opus-5-5';
export const DEFAULT_REVIEW_EFFORT = 'high';

// Models that accept fallbacks: "default" (Claude API).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** The send options that turn fallbacks on for a supported model; none for any other. */
export const fallbackOptions = (model) => (FALLBACK_MODELS.has(model) ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {});

/** @param {{ apiKey?: string, client?: object }} [options]  client: a fake for tests (messages.create and beta.messages.create) */
export function createReviewClaude({ apiKey, client } = {}) {
  // An explicit timeout lets a large non-streaming max_tokens through (the SDK otherwise refuses
  // anything it estimates could pass 10 minutes); 20 minutes covers a full 32k-token response.
  const core = createClaude({ apiKey, client, maxRetries: 3, timeoutMs: 20 * 60 * 1000 });
  return { send: (opts) => core.send({ ...fallbackOptions(opts?.model), ...opts }) };
}
