# Upstream model discovery

Status: implemented (fork `findtheworld-kk/llm-api-bench-self`, 2026-09-05)

## Problem

Adding a provider meant typing every model by hand: model ID, display name, context
size, plus three capability checkboxes — seven controls per model, in a two-column
grid of cards that scrolls inside a 400 px window.

On the deployment this fork serves, that cost showed up in the data: 11 providers,
12 models total — an average of **1.09 models per provider**, with every context size
left at the 4096 default. The instance exists to compare models against each other,
and the configuration cost had quietly capped it at one model per upstream.

Meanwhile the upstreams already publish everything the form asks for. OpenRouter's
`GET /v1/models` returns 431 models with `context_length`, `input_modalities` and
`supported_parameters`; Anthropic's returns `display_name`; Gemini's returns
`inputTokenLimit`.

## Options considered

| | Change | Cost |
|---|---|---|
| A | A "load from upstream" button opening a picker dialog | Small, easy to upstream — but 20 picked models still become 20 cards |
| B | Model-ID input becomes a searchable select | Smallest diff — but still one model at a time |
| **C** | **Model area becomes a list: connect, then tick** | **Rewrites the model area — but works at 431-model scale and shows what the upstream has that you don't** |

C was chosen. The rendered comparison (current-state replica, measurements, all three
options) is archived at `~/Documents/Tasks/2026-09-05-bench-model-discovery/`.

## Shape

- `backend/src/providers/modelDiscovery.ts` — `listRemoteModels()`, one list endpoint
  per provider format, 15 s timeout, dedupe/sort/cap at 1000. Metadata is best-effort:
  absent fields stay `undefined` and the UI falls back to its defaults rather than guessing.
- `backend/src/routes/providers.ts` — the two discovery routes. The saved-provider route
  decrypts the stored key only when the form did not carry a fresh one.
- `frontend/src/components/SettingsPage.tsx` — the list. Rows are the union of configured
  models and discovered ones, keyed by model ID; ticking a row adds it to the form,
  unticking removes it. Rows the upstream does not know about keep an editable ID field,
  so a provider without a `/models` endpoint degrades to the old manual flow.

## Known limits

- An upstream without a model-list endpoint returns 404; the UI says so and manual entry
  still works.
- Anthropic's and Gemini's list endpoints carry no per-model capability flags, so vision
  and tools are assumed true for those formats.
- Discovery reads models only. It never writes to the monitor's target list; selecting a
  model in this form still only configures the provider.
