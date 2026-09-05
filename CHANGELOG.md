# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Upstream model discovery.** The provider form can now read the model list from the endpoint itself: fill in Endpoint URL and API key, press "Connect & load models", and every model the upstream advertises appears as a checkbox list — no more typing model IDs by hand. Context size, vision and tool-calling flags are filled in from the upstream response where it provides them (OpenRouter-style gateways do; plain OpenAI does not, and those fields fall back to the previous defaults). New endpoints: `POST /api/providers/discover-models` for an unsaved form and `POST /api/providers/:id/discover-models` for a saved provider, which reuses the stored key unless a new one was typed

### Fixed
- **A model with no display name could not be saved.** The form always sends the field, and an empty string failed the display-name pattern — so any provider holding a model you had not named was rejected with "Display name: 1-96 chars…". Predates model discovery (upstream's blank model row sends `displayName: ''` too), but discovery makes it constant: upstreams that return bare model IDs, with no label, produce a whole list of unnamed models. An empty display name now means "not set"
- A failed save no longer closes the form. It used to close on both paths, throwing away every model just picked and leaving the error behind the closed dialog; the error is now shown inside the form, and antd's `Alert` gets `message` instead of the `title` prop it ignores

### Changed
- Display names accept letters and digits in any script plus the punctuation vendors actually use — `Cohere: Command R+ (08-2024)`, `Nous: Hermes 4, 70B`, `通义千问 2.5`. Markup characters stay rejected
- **The model area of the provider form is a list, not a grid of cards.** One row per model with a filter box, "select matching" and "selected only", inline display-name editing, and per-row details (context size, vision, tools, streaming, active) behind a disclosure. This keeps the form usable at the scale upstreams actually serve — 431 models on OpenRouter today, where 20 selected models used to mean 1762 px of card grid
- A row is tagged "Monitored" when the monitor is already checking that provider + model
- A new provider starts with no model rows; models come from discovery or from "Add manually"
- Model IDs may now be up to 128 characters and contain `:`, `@`, `+` and a leading `~` — the shapes real gateways return (`qwen/qwen3-235b-a22b:free`, `~anthropic/claude-opus-latest`)

## [2.15.3] - 2026-05-15

### Changed
- CI workflow reverted to strict mode: tag pushes run the full `quality` job before `docker`. v2.15.2 had skipped `quality` on tag pushes to avoid duplicate CI runs, but that left a security gap — a tag pointing at an unvalidated commit (e.g. `git tag v9.9.9 some-sha` directly) could trigger a Docker push without going through type check / lint / tests. Each release now runs `quality` twice (once on branch push, once on tag push) but guarantees Docker images are only built from validated commits

## [2.15.2] - 2026-05-15

### Fixed
- CI: lint failures on `mainStarted`/`warmupCount` (unused locals in `benchmarkEngine.run.test.ts`) and `DEFAULT_CONFIRM_DELAY_MS` (unused fallback in `alertNotifier.ts`). Renamed the latter to `_DEFAULT_CONFIRM_DELAY_MS` and dropped the test locals — verification was already covered by `expect(execute).toHaveBeenCalledTimes(...)`
- CI workflow: `quality` job now skips on tag pushes (the same commit was already validated on the branch push). Eliminates the duplicate CI runs that fired on every release — one for `push branches:main`, one for `push tags:v*`. The `docker` job still triggers on tag pushes and no longer depends on `quality` (the underlying commit was already validated)

## [2.15.1] - 2026-05-15

### Fixed
- CI: `supertest` and `@types/supertest` moved from root `package.json` to `backend/package.json`. Local tests passed because TypeScript resolves up the directory tree to root `node_modules`, but CI installs each sub-package independently and could not find the module. Type check now passes in CI

## [2.15.0] - 2026-05-15

### Changed
- **Alert confirmation now uses K-of-N voting** instead of "N consecutive failures or one ok abandons cycle". A new `alertConfirmFailThreshold` setting (default `N - 1`, e.g. 4-of-5) controls how many of the N attempts must fail to fire an alert. A single transient ok no longer drops the entire confirmation chain — fixes the case where a flaky upstream that returns one healthy response between failures suppressed real outage alerts for 30+ minutes
- Confirmation cycles now exit early on both directions: alert fires the moment failCount reaches the threshold (no longer waits for the full N attempts), and the cycle abandons the moment failThreshold becomes mathematically unreachable
- Health-check probe timeout reduced from 180 s (streaming) / 120 s (non-streaming) to 90 s for monitor probes and the "Test Connection" endpoint. Playground/benchmark calls retain their longer timeouts
- Confirmation probes within the same provider now run in parallel (independent API calls). Previously serialized — a single hung confirmation could delay every other model's confirmation in the same minute

### Fixed
- **Race in confirmation queue**: between `pendingConfirmations.delete(key)` and the re-add after `await confirmProbe`, the dedup gate `has(key)` returned false, allowing a scheduled probe landing in that 60-180 s window to spawn a duplicate parallel confirmation cycle. Added an `inFlight` token map so the gate covers the await window, and any cycle whose token is overwritten/cleared mid-await drops its result
- **Recovery alert no longer leaves a zombie down cycle in flight**: when a scheduled probe sees `healthy/slow` after `down`, the recovery alert now explicitly cancels any pending or in-flight confirmation for that target, preventing a delayed redundant down alert
- **Webhook delivery failures now retry instead of silently consuming the alert** (bug #4): when the Feishu webhook returns non-2xx, `sendFeishuAlert` throws instead of just logging. The fire path catches the throw and re-queues the confirmation cycle rather than recording `lastAlertAt` — previously a failed delivery still recorded the alert, suppressing all retries for 6 hours
- **`useMonitor.saveConfig` no longer "phantom-saves"** (bug #8): UI no longer mirrors the new config into local state on non-2xx responses. Returns `boolean` so callers can detect failures
- **`usePlaygroundHistory` no longer "phantom-deletes"** (bug #2): `deleteEntry` and `clearAll` now check `res.ok` before mutating local state — failed server deletions no longer hide items locally
- **`useWorkflow` mutations surface server errors** (bug #1): `cancelWorkflow` / `deleteWorkflow` / `duplicateWorkflow` now check `res.ok` and propagate the server's error message into `state.error` instead of silently returning false/null
- **`useBenchmark` rejects malformed responses** (bug #3): `fetchBenchmarks` validates that the body is an array, `fetchBenchmark` validates it's a plain object. Non-2xx and shape mismatches set an error rather than polluting React state with `{error:'…'}` placeholders
- **`PUT /api/monitor/targets` now accepts an empty array** (bug #7): `MonitorTargetsArraySchema` dropped `.min(1)`, letting users clear the monitor list entirely
- **`startWorkflow` correctly toggles `isRunning`** (bug #6): set `true` at the start of the try-block so the catch-branch's `setIsRunning(false)` is no longer a no-op
- **`providerStore.create` / `update` reject duplicate model id/name within a provider** (bug #5): collisions previously corrupted monitor target tracking. Routes return 400 with the conflict message

### Added
- New monitor config field `alertConfirmFailThreshold` (range 1-20, clamped to `[1, alertConfirmCount]` server-side)
- Settings UI exposes the K threshold as a `K / N` selector that auto-adjusts options when N changes
- Comprehensive test coverage expansion: 906 total tests (712 backend + 194 frontend) covering alert state coordination, K-of-N decision math, multi-provider streaming token fields, route HTTP semantics via supertest, store CRUD with sqlite migrations, and full executeWorkflow integration with real benchmarkEngine
- "Writing tests" discipline section in `CLAUDE.md` capturing the lesson from the May 2026 reverse-review: 8 bugs were silently rationalized by tests that matched current behavior instead of expected behavior

## [2.14.0] - 2026-05-13

### Added
- Configurable alert confirmation: number of consecutive failures (default 5, range 1-20) and delay between checks (default 1 min, range 1-60) before sending alerts, replacing the previous fixed single 1-minute re-check
- Monitor settings UI exposes confirm count and confirm delay alongside language and reminder interval

### Fixed
- Alert reminder interval ignored: every save of monitor settings was wiping `last_alert_at` because `setTargets`/`addTarget` rebuilt the row without preserving the column, so reminders fired roughly every probe interval instead of every 6 hours
- Down/very_slow status oscillation triggered spurious "new failure" alerts instead of reminders; `wasDown` now treats both as the same down state
- Backend dev watcher missed source edits made by atomic-replace writes (inode changes); switched from `tsx watch` to `nodemon --legacy-watch` polling
- Frontend dev watcher hardened with `usePolling` for parity
- PUT `/api/monitor/config` silently dropped `alertConfirmCount` and `alertConfirmDelayMinutes` from the request body, so UI changes were not persisted
- Alert confirmation probe now records a ping on error (previously failed probes left no DB trace) and re-queues on transient failures instead of silently dropping the confirmation

## [2.13.1] - 2026-05-11

### Changed
- Alert confirmation: down/reminder alerts now require a second probe after 1 minute to reduce false positives
- Recovery alerts are still sent immediately without confirmation
- Switch docker-compose.yml to use Docker Hub image (`idemerge/llm-api-bench`)
- Remove unused variables flagged by code quality analysis

## [2.13.0] - 2026-05-11

### Added
- Full i18n support with Chinese/English language switcher (react-i18next)
- Feishu webhook alert notifications for monitor
  - Per-target alert enable/disable toggle
  - Status change detection: new failure, repeated failure (configurable interval), recovery
  - DB-persisted alert state (survives restarts)
  - Optional webhook signature verification
  - Configurable notification language (en/zh, default en)
- Alert bell indicator on monitor model cards (color-coded by health status)

### Changed
- All hardcoded UI strings replaced with i18n translation keys
- Monitor settings modal now includes alert configuration section (webhook URL, secret, language, reminder interval)

## [2.12.1] - 2026-04-28

### Fixed
- Touch targets undersized: removed `size="small"` from Settings buttons, increased model tag padding
- Heading scale too flat: increased H1 from 20px to 24px
- Capability tags (T/S/V) nearly illegible: increased font from 8px to 10px with larger padding
- Mobile parameter labels overflow: responsive grid for Core Parameters section
- Playground history panel overlaps form on mobile: full-screen overlay on mobile
- Grammar: "1 models" now correctly pluralized across Monitor and History pages
- antd deprecation: replaced Alert `message` prop with `title` (5 instances)
- History page duplicate heading: removed redundant H2 title (topbar already shows page name)

## [2.12.0] - 2026-04-28

### Added
- Naming validation rules for Provider name, Model ID, and DisplayName (backend + frontend)
  - Provider name: alphanumeric/dash/underscore, no spaces, 1-64 chars
  - Model ID: alphanumeric/dash/underscore/dot/slash, 1-64 chars (LiteLLM compatible)
  - DisplayName: alphanumeric/space/dash/underscore/dot, 1-64 chars
- Frontend real-time validation with error hints on Settings provider form
- Frontend validation unit tests (16 cases)
- Backend validation boundary tests (4 cases)

### Changed
- Renamed project from LLM API Radar to **LLM API Bench** (repo, UI, docs, Docker image)
- Playground history sidebar now shows `ProviderName/DisplayName` instead of raw model ID
- Backend stores model displayName in playground history for friendly display
- Adaptive QuickButtons sizing: auto-shrink when >7 options to prevent line wrapping

### Fixed
- Getting Started hint no longer flashes on page refresh (waits for data load)
- Playground provider/model selectors no longer flash raw IDs before names load
- Playground history correctly resolves model displayName from provider data

## [2.11.3] - 2026-04-28

### Changed
- Raised max concurrency from 1000 to 5000 (frontend InputNumber, backend validation schemas, route caps)
- Raised max iterations from 1M to 10M (frontend InputNumber, backend validation schemas, route caps)
- Added quick-select buttons for 2K/5K concurrency and 5M/10M iterations
- Updated README (EN/CN) with corrected `cd` path and new concurrency/iterations limits
- Fixed Quick Start instructions: `cd llm-benchmark` → `cd llm-api-bench`

## [2.11.2] - 2026-04-27

### Changed
- Demo mode now masks vendor-prefixed model names (e.g. `z-ai/glm-4.7` → `ProviderX/glm-4.7`) and workflow `providerSummaries`, sharing a single id-stable letter namespace across providers and vendors
- Masking is fully applied at the React hook fetch boundary (`useWorkflow`, `useMonitor`, `usePlaygroundHistory`, `useProviders`); the legacy DOM regex redactor is now a deprecated no-op safety net
- Regenerated all 6 README screenshots and `docs/demo.gif` under `VITE_DEMO_MODE=true`

### Fixed
- Workflow result table no longer leaks raw provider names through `summary.providerSummaries[*].provider` (previously masked only by the DOM regex layer)

## [2.11.1] - 2026-04-27

### Added
- Sensitive info redaction module (`scripts/redact-sensitive.mjs`) for screenshots and GIF recording — provider names, API URLs, and keys are automatically replaced with generic labels
- Screenshot script (`take-screenshots.mjs`) now calls `redactPage()` before each capture
- Demo recorder (`record-demo.mjs`) installs a persistent `MutationObserver` to redact text as React re-renders during screencast

### Fixed
- Playground: disable image upload button for non-vision models and clear uploaded images when switching to a non-vision model
- Workflow SSE: fix race condition where `activeRunIdRef` was cleared after `fetchWorkflow`, causing stale state — now fetches final workflow state directly before clearing ref

### Changed
- Regenerated all 6 screenshots and demo GIF with redacted sensitive information
- Removed `prettier` from frontend and backend devDependencies (unused)

## [2.11.0] - 2026-04-27

### Added
- Workflow page now shows the same Mission Control header (status, duration, edit) and Live Metrics strip (avg RT, TPS, last RT) + cooldown countdown that History Detail had — exposed via `liveMetrics` and `cooldown` from `useWorkflow`
- New shared `WorkflowHeader` component used by both the active Workflow page and History Detail

### Changed
- Refactored `HistoryDetailPage` to compose `WorkflowHeader` instead of duplicating header markup (~280 line reduction)
- Tightened pre-commit lint gate: `lint-staged` now runs `eslint --max-warnings 0` on staged frontend files

### Fixed
- CI lint failure on v2.10.1: removed empty `catch {}` block in `HistoryDetailPage` and silenced react-hooks warnings via targeted disables (no behavior change)
- Various react-hooks lint warnings across `ConfigPanel`, `MonitorPage`, `PlaygroundPage`, `WorkflowConfigPanel`, `WorkflowProgress`

## [2.10.1] - 2026-04-23

### Changed
- Raised concurrency limit from 200 to 1000 and iterations limit from 2000 to 1M (frontend InputNumber + backend Math.min caps)
- Updated quick-select buttons: concurrency adds 500 and 1K options, iterations adds 10K, 100K, and 1M options

## [2.10.0] - 2026-04-23

### Added
- Workflow name inline editing with PATCH endpoint and edit UI in History Detail header
- Running workflow "Mission Control" experience: live metrics strip (avg RT, TPS, last RT), cooldown countdown timer between tasks, real-time elapsed timer
- Completed workflow stat-card dashboard: Duration, Tokens, Best Avg RT, Success Rate, Total T/s in a 6-column grid
- History list redesign: colored status icons, config chips (concurrency × iterations × tokens + cache rate + stream), dedicated Models column with provider-colored tags, Duration and Tokens columns
- Monitor Settings as Modal dialog (replaces inline collapsible panel) with scrollable Targets area
- CSS design system additions: `stat-card` / `stat-value` / `stat-label`, `section-header` with color variants, `running-card-glow` animation, `running-row-active` styling, Ant Design overrides for tables, tooltips, and popconfirm

### Changed
- History Detail running state: animated amber border glow, live metrics from SSE `latestResults`, per-task completed summaries showing fastest RT and highest TPS providers
- History Detail completed state: stat-card grid replaces flat text metrics for visual impact
- History Panel: complete rewrite with richer row content and consistent visual hierarchy
- Monitor: summary bar uses `stat-card` CSS class, threshold inputs use Ant Design `InputNumber`, chart tooltip uses CSS variables, removed redundant tok/s display, unified TTFT/TPS status coloring
- Playground: MetricsRow uses `stat-card` with provider-colored accents, provider label uses `getProviderColor`
- WorkflowResults: removed bar charts (MetricBarChart, TaskCharts) — cleaner table-only layout
- WorkflowProgress: added live metrics strip, cooldown timer, elapsed timer, completed task summary pills
- WorkflowConfigPanel: cache hit rate input width narrowed for compact layout

## [2.6.0] - 2026-04-23

### Added
- Output Scope selector for long-context presets (16K/64K/150K/256K): controls how many documents the model reads, limiting output length (~500 tokens for 3 docs, unlimited for All docs)
- Output Scope available in Benchmark, Workflow, and Playground pages with persistent selection via localStorage
- Input/Output/Total throughput metrics in Workflow Detail: calculated as concurrency × avg tokens per request / avg response time
- Throughput columns (In T/s, Out T/s, Total T/s) in provider comparison tables
- Throughput summary in workflow header and results summary bar
- Tooltips on all metric labels, table column headers, and parameter controls across all pages (WorkflowResults, ResultsPanel, ConfigPanel, PlaygroundPage, HistoryDetailPage)

### Changed
- Long-context 64K preset prompt suffix updated to support configurable output scope

## [2.5.1] - 2026-04-19

### Added
- Workflow task editor: duplicate button to clone an existing task with all its configuration

### Fixed
- Duplicating, deleting, or reordering tasks now correctly preserves heavy prompts (>10K chars) instead of silently truncating them

## [2.5.0] - 2026-04-18

### Added
- History list: show concurrency and iteration count columns
- History detail: show input/output token counts and ratio (In:Out)
- History detail: real-time iteration progress bar for running workflows via SSE
- Backfill input/output token stats for older workflows on first access

### Changed
- Long context preset prompts: balanced for ~40:1 input-to-output token ratio with "Don't overthink this" guidance

## [2.4.6] - 2026-04-18

### Fixed
- Cache hit rate: reduced sliding window from concurrency-sized (e.g. 50) to fixed 5, keeping KV cache memory pressure realistic for large prompts

## [2.4.5] - 2026-04-18

### Fixed
- Cache hit rate: reuse now picks from a sliding window of recent prefixes (sized to concurrency) instead of the entire pool, avoiding stale entries that inference engines (SGLang, vLLM) may have evicted under memory pressure

## [2.4.4] - 2026-04-18

### Changed
- Cache hit rate: replaced fixed-K-prefixes + shuffle with per-request Bernoulli scheduling — each request independently rolls miss/hit with the target probability, producing a uniform distribution throughout the run instead of clustering all misses at the start

## [2.4.3] - 2026-04-18

### Fixed
- Cache hit rate: `targetCacheHitRate` was silently dropped by both the benchmark and workflow route handlers — the field was validated but never passed to the engine, so the feature had no effect

## [2.4.2] - 2026-04-18

### Fixed
- Cache hit rate: prefix size now adapts to prompt length (~5%, clamped 128–4096 chars) to avoid inflating short prompts — previously a fixed ~4 KB prefix would double a 1K-token input

## [2.4.1] - 2026-04-18

### Fixed
- Cache hit rate: replaced short UUID prefix (~5 tokens) with ~1024-token random prefix to reliably bust block-level KV cache on inference engines (vLLM, SGLang, etc.)
- Cache hit rate: replaced round-robin variant assignment with Fisher–Yates shuffled schedule so cache misses are spread evenly across the run instead of clustered at the start

## [2.4.0] - 2026-04-18

### Added
- Cache hit rate control (`targetCacheHitRate`): prepends unique UUID prefixes to each request to simulate realistic multi-user traffic with configurable prefix-cache hit rate (0–99%). Available as a toggle + percentage input in the WorkflowConfigPanel Advanced section. Formula: K = iterations × (1 − rate) unique variants, cycled round-robin.

## [2.3.0] - 2026-04-18

### Changed
- Raised concurrency limit from 50 to 200 and iterations limit from 1000 to 2000
- Replaced batch-based concurrency with sliding-window worker pool to maintain steady in-flight request count — previously, requests that completed early left slots idle causing actual concurrency to drop over time; now a new request starts immediately whenever one finishes

## [2.2.0] - 2026-04-17

### Added
- Long Context 150K preset: a new built-in prompt preset (~150,000 tokens) bridging the gap between the existing 64K and 256K presets. Available in ConfigPanel, WorkflowConfigPanel, and PlaygroundPage. Loaded on demand via dynamic import to avoid bundle size impact.

## [2.1.0] - 2026-04-16

### Added
- `maxQps` parameter for workflow tasks: global token bucket rate limiting across all concurrent slots. Set to a positive integer to cap requests per second; `0` means unlimited. Available in the WorkflowConfigPanel Advanced section with quick-select buttons (Off / 1 / 5 / 10).
- Token bucket implementation in the benchmark engine with cancellation support — rate limiting integrates cleanly with existing cancel flow and does not affect `requestInterval` or `concurrency` behavior.

## [2.0.0] - 2026-04-13

### Security
- Eliminated all hardcoded secrets: JWT secret, encryption key, and salt are now auto-generated and persisted to `data/` directory
- Force password change on first login with default credentials (`changeme`)
- Restricted CORS to configured origin (default: same-origin only)
- Added login rate limiting (5 attempts per 5 minutes per IP)
- Added Helmet security headers with Content Security Policy
- Moved auth verify and change-password endpoints behind authentication middleware
- Replaced JWT-in-query-string with short-lived one-time tokens for SSE and download URLs
- New password must differ from current password when changing
- JWT token storage moved from `localStorage` to `sessionStorage`

### Added
- Zod schema validation for all API request bodies with descriptive error messages
- `ProviderConfigUpdateSchema` for partial provider updates
- `POST /api/auth/change-password` endpoint
- `POST /api/auth/sse-token` endpoint for one-time token exchange
- Shared SQLite connection singleton with WAL mode and busy timeout
- CSV escaping utility to prevent injection in exports
- Express Request type augmentation (`req.user`)
- 5 new test suites: encryption, auth middleware, validation schemas, benchmark engine, store sync (65 backend tests total)

### Changed
- SQLite-first write pattern across all stores: DB writes before in-memory Map updates to prevent inconsistency on failures
- Encryption migration runs synchronously before server startup to prevent race conditions
- Monitor cleanup runs daily at 3am with 7-day retention
- `cancelledRuns` cleanup in benchmark engine on both success and error paths
- PRAGMA `table_info` migration pattern replaces try/catch `ALTER TABLE`
- `apiKeys` field in benchmark and workflow schemas is now optional with empty default
- `supportsVision`/`supportsTools` use nullish coalescing (`??`) instead of logical OR

### Fixed
- Encryption migration race condition — server could accept requests before migration completed
- `store.delete()` violated SQLite-first pattern (deleted Map before DB)
- `PUT /api/providers/:id` had no input validation
- Monitor error responses returned HTTP 200 instead of 500
- Provider test endpoints could crash the server on connection failure (now returns 502)
- Workflow error recovery could overwrite cancellation status
- Frontend infinite re-render loop on History page with running workflows
- EventSource not cleaned up on component unmount in useWorkflow hook
- Missing `pageConfig` fallback for unknown routes
- Redundant `method`/`action` attributes on login form

### Removed
- Dead code: `backend/src/services/store-old.ts`

## [1.3.3] - 2026-04-13

### Changed
- Merged Docker publish into CI pipeline — Docker image build now requires all quality checks to pass first
- CI workflow also triggers on version tags so quality gate runs before Docker push

### Fixed
- CI lint warnings: cleaned up unused imports/variables across frontend and backend
- Upgraded GitHub Actions to v5 (Node.js 24 compatible)
- Root docs (CHANGELOG, README, docker-compose) excluded from Prettier formatting
- lint-staged glob expanded to cover config `.js` files

## [1.3.2] - 2026-04-13

### Added
- Vitest test framework with initial test suites (frontend: tokenCount, MonitorPage helpers; backend: MonitorStore CRUD)
- Prettier for consistent code formatting across frontend and backend
- ESLint for backend (flat config, typescript-eslint)
- Husky pre-commit hook with lint-staged (auto-format on commit)
- GitHub Actions CI pipeline: typecheck, lint, format check, tests, build
- `scripts/release.sh` for automated version bump, changelog update, tag, and push

### Fixed
- 11 TypeScript type errors across the codebase (ResultsPanel JSX, App.tsx, WorkflowResults, etc.)
- CI error messages now show specific failures and actionable fix instructions

## [1.3.1] - 2026-04-10

### Added
- Monitor trend charts: expandable TTFT, TPS, and Latency time-series graphs per model with 1h/6h/24h range selector and threshold reference lines

### Fixed
- Playground history: clicking a failed history entry no longer crashes (undefined metrics guard)
- Playground history: selecting a record whose provider was deleted no longer causes a blank screen (graceful fallback to empty provider selection)

## [1.3.0] - 2026-04-09

### Added
- Monitor health classification now based on TPS (tokens per second) instead of raw latency
- Monitor probe prompt upgraded to generate longer responses for accurate TPS measurement
- Provider deletion cascades to monitor targets cleanup
- Provider model rename auto-syncs monitor targets (preserves monitoring config)
- Anthropic streaming fallback: read `input_tokens` from `message_delta` for LiteLLM compatibility

### Changed
- Monitor health thresholds: `latencySlowMs`/`latencyVerySlowMs` replaced with `tpsSlowThreshold` (default 20) / `tpsVerySlowThreshold` (default 5)
- Monitor UI tooltips show TPS instead of latency as primary metric
- Workflow templates default `warmupRuns` changed from 2 to 0
- Quick Benchmark and Workflow config default `warmupRuns` changed from 2 to 0

### Fixed
- `formatNumber` crash when token values are undefined (WorkflowResults page)
- Workflow detail table showing Tokens as 0 (field mismatch: `promptTokens` vs `totalTokens`)
- Orphaned monitor targets remaining after provider model rename or deletion

## [1.2.1] - 2026-04-07

### Changed
- Playground image input redesigned: inline button at prompt bottom, drag-and-drop, clipboard paste support (matching ChatGPT/Claude UX)
- Playground Run button moved to prompt textarea bottom-right for faster access
- Config row (Max Tokens, Streaming, Thinking) moved above prompt area
- Presets integrated into prompt bottom bar
- Removed URL image input (file upload only)

## [1.2.0] - 2026-04-07

### Added
- Playground history with SQLite persistence, auto-save on every run
- History sidebar with replay: click any past run to restore prompt, config, and response
- Thinking/reasoning toggle for Anthropic extended thinking and OpenAI reasoning effort
- Copy response button in Playground
- Long Context presets (8K/16K/32K/64K/128K) in Playground
- Backend image validation (size and count limits)

### Fixed
- Anthropic extended thinking not working (wrong API version, missing thinking params)
- Anthropic required CLI headers accidentally removed
- Playground upstream API calls not aborted when client disconnects (resource leak)
- Gemini using fake conversation turns instead of native `systemInstruction`
- Playground `/run` returning HTTP 200 on errors instead of 502
- Image URLs silently dropped for Anthropic/Gemini (now fetched and converted to base64)
- Backend `maxTokens` default misaligned (512 vs 4096)
- Flash of empty state on Monitor, Config, and Workflow pages before data loads

### Changed
- History sidebar defaults to open for better discoverability
- Playground design polish: label sizes, config row layout, mobile responsiveness

## [1.1.0] - 2026-04-04

### Added
- Gemini streaming support (`streamGenerateContent` with `alt=sse`) for accurate TTFT measurement
- Gemini streaming in Playground with real-time token output
- History page refresh button for manual data reload
- Auto-refresh History page every 30s when running workflows exist
- Reload workflow data when navigating to History page

### Fixed
- Gemini TTFT always showing 0 due to missing streaming implementation
- Playground non-streaming TTFT showing fabricated value (`responseTime * 0.3`) instead of N/A
- Playground Gemini image input not being passed to API (images were silently dropped)
- Playground Gemini format falling back to non-streaming instead of using native streaming
- Frontend TTFT displaying `0ms` instead of `N/A` for non-streaming requests (WorkflowResults, ResultsPanel, PlaygroundPage)
- Non-streaming `/run` endpoint not passing images parameter to provider

### Changed
- `backend/public/` added to `.gitignore` (build artifact)

## [1.0.3] - 2026-04-04

### Changed
- Renamed project from LLM Benchmark to LLM API Radar
- Updated all UI references, branding, screenshots, and demo GIF

## [1.0.0] - 2026-04-04

Initial release.

### Features
- Multi-provider benchmark engine (OpenAI, Anthropic, Gemini, OpenAI-Compatible)
- Workflow engine with multi-task sequential execution
- Per-task prompt, concurrency, and iteration configuration
- Warmup runs to eliminate cold-start bias
- Live streaming metrics with per-provider area charts
- Radar comparison across all dimensions
- Persistent run history with full result details
- JSON and CSV export
- Playground page with streaming, vision support, and image upload
- Monitor page with periodic health checks, configurable thresholds, and 24h history
- JWT-based authentication with configurable credentials
- Docker deployment with multi-stage alpine build
- One-click build script (`start.sh`) and Docker Compose
- GitHub Actions workflow for Docker Hub auto-publish on tag push
- Dark theme UI with Ant Design 5
- SQLite storage with single-file database
