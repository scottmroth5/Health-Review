// The review's Claude client: agent-core's createClaude (cached system prompt, structured output,
// stop_reason checks, cost, tracing) over an SDK client that adds server-side refusal fallbacks on
// models that support them, so a declined request is retried on a fallback model in the same call.
import Anthropic from '@anthropic-ai/sdk';
import { createClaude } from '@scottmroth5/agent-core';

export const DEFAULT_REVIEW_MODEL = 'claude-opus-5-5';
export const DEFAULT_REVIEW_EFFORT = 'high';

// Models that accept fallbacks: "default" (Claude API).
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** An object exposing messages.create, as createClaude expects. */
export function withFallbacks(sdk) {
  return {
    messages: {
      create: (params) =>
        FALLBACK_MODELS.has(params.model)
          ? sdk.beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' })
          : sdk.messages.create(params),
    },
  };
}

/** @param {{ apiKey?: string, client?: object }} [options]  client: a fake for tests */
export function createReviewClaude({ apiKey, client } = {}) {
  // An explicit timeout lets a large non-streaming max_tokens through (the SDK otherwise refuses
  // anything it estimates could pass 10 minutes); 20 minutes covers a full 32k-token response.
  return createClaude({ client: client ?? withFallbacks(new Anthropic({ apiKey, maxRetries: 3, timeout: 20 * 60 * 1000 })) });
}
