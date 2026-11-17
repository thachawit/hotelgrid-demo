# Pricing notes (as of 2026-11-03)

Source: Anthropic first-party list prices (claude-api skill model table, cached 2026-11-03). Re-check the provider
pricing page before any decision; prices change. The demo maps tiers: large = Opus 5.5, medium = Sonnet 5.5,
small = Haiku 5.5.

## Per-million-token list prices
- large (claude-opus-5-5): input $4.00, output $20.00, cache read $0.20.
- medium (claude-sonnet-5-5): input $2.00, output $10.00, cache read $0.10.
- small (claude-haiku-5-5): input $0.10, output $0.50 for prompts up to 100K tokens.
- Cache write price is assumed at 1.25x input in this demo (not in the cached source).

## Prompt caching
Caching is a prefix match: any byte change in the cached prefix (tools, system, earlier messages) invalidates the
cache. A timestamp or request id inside the system prompt makes every request a cache write. Cache reads cost about
5% of the input price on current Claude models. Minimum cacheable prefix depends on the model (512-4096 tokens);
shorter prefixes silently do not cache. Verify with cache_read_input_tokens > 0.

## Batch processing
Message Batches run asynchronously at 50% of standard price. Good fit: CI golden-set runs, nightly re-scoring,
shadow evals. Bad fit: guest-facing chat.

## Effort
Lower effort on the same model is the first quality-trading lever after free wins. Try the most capable model at
lower effort before building a multi-model cascade: caches are model-scoped, so a cascade loses cache reuse.
Judge cost per completed task, not per request.
