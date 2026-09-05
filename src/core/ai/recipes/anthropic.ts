import type { Recipe } from '../types.ts';

/**
 * Anthropic provides language models (expansion + chat) only.
 * Claude has no first-party embedding model as of v0.27 ship date. Users who
 * want a fully Anthropic stack would still use OpenAI or Google for embedding.
 */
export const anthropic: Recipe = {
  id: 'anthropic',
  name: 'Anthropic',
  tier: 'native',
  implementation: 'native-anthropic',
  auth_env: {
    required: ['ANTHROPIC_API_KEY'],
    setup_url: 'https://console.anthropic.com/settings/keys',
  },
  touchpoints: {
    // No embedding model available.
    expansion: {
      models: ['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-sonnet-4-6'],
      cost_per_1m_tokens_usd: 0.25,
      price_last_verified: '2026-05-10',
    },
    chat: {
      models: [
        'claude-fable-5',
        'claude-opus-5',
        'claude-opus-4-8',
        // FLEET FORK PATCH (2026-08-03, re-applied on v0.48.2.0 2026-09-04):
        // relay-only fable-5-1 alias (claude-apr :18810), the `think` +
        // brainstorm/LSD model. fable-5 parity. Upstream already ships bare
        // 'claude-fable-5' above — do NOT re-add it (duplicate key).
        'claude-fable-5-1',
        'claude-opus-4-7',
        'claude-sonnet-5',
        'claude-sonnet-4-6',
        'claude-haiku-4-5-20251001',
      ],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: true,
      model_context_tokens: {
        // FLEET FORK PATCH (v0.48.2.0 2026-09-04): fable-5-1 at fable-5 parity.
        // This map is where upstream moved the old
        // src/core/cycle/synthesize.ts MODEL_CONTEXT_TOKENS (deleted upstream).
        'claude-fable-5-1': 1_000_000,
        'claude-fable-5': 1_000_000,
        'claude-opus-5': 1_000_000,
        'claude-sonnet-5': 1_000_000,
        'claude-opus-4-8': 1_000_000,
        'claude-opus-4-7': 1_000_000,
        'claude-opus-4-6': 1_000_000,
      },
      max_context_tokens: 200000,
      cost_per_1m_input_usd: 3.0, // sonnet-class baseline
      cost_per_1m_output_usd: 15.0,
      price_last_verified: '2026-05-10',
    },
  },
  // Friendly aliases. Starting with Claude 4.6, Anthropic API IDs are dateless
  // and pinned (no alias needed). Only pre-4.6 models need date-suffixed aliases.
  // The reverse entry rewrites the v0.31.6-shipped broken ID back to canonical
  // so users with stale `models.dream.synthesize` etc. configs keep working.
  aliases: {
    'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6-20250929': 'claude-sonnet-4-6',
  },
  setup_hint: 'Get an API key at https://console.anthropic.com/settings/keys, then `export ANTHROPIC_API_KEY=...`',
};
