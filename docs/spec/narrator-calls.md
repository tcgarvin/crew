# Narrator calls

When the sim stops for the narrator, how the call travels from the browser to the model and back,
and what happens when it fails. What the narrator is told and may do is in `narrator-story.md`.
Code: hook raising in `packages/sim/src/core/hooks.ts` and `packages/sim/src/systems/travel/`;
the call in `packages/narrator/src/` and `packages/server/src/routes/narrator.ts`; the browser
side in `apps/web/src/host/narrator*.ts` and `App.tsx`.

## Narrator hooks

### Hook halting

The narrator is hook-driven and synchronous (D5): the sim pauses at authored hook points, the UI
shows a loading state, the server calls the model, and the returned commands apply at the hook
tick + 1. Preconditions are still validated at apply time. At most one hook is pending
(`state.narrator.pendingHook`); `raiseHookIfIdle` is a no-op while one is, and every caller
retries on a later tick if it must. `advance()` does not step while a hook is pending, unless its
`acknowledgeHook` is already queued. Acknowledging spends the hook; it also deletes a call-back
request that hook served (§requested-call-back). The run-ahead lead (see `architecture.md`) hides
the first seconds of a call from the viewer.

### Hook kinds

| Kind | Raised when |
|---|---|
| `stageDock` | the approach to a port with a dock map (§staging-hook-and-the-hold) |
| `captainAshore` | the captain steps onto the dock looking for work (§captain-ashore-ask) |
| `requestedCall` | a call the narrator asked for comes due (§requested-call-back) |
| `notableEvent` | a hookable event happened (§notable-event-hook) |
| `policyDecision` | a kernel-raised decision reaches the head of the queue (§policy-decision-hook) |
| `quietTooLong` | too long since any narrator contact (§quiet-check-in) |

All but `stageDock` are story hooks. Order within a tick: `stageDock`, `requestedCall`,
`notableEvent` (all travel), `captainAshore` (commerce), `policyDecision`, `quietTooLong` last;
the first raised wins and the rest wait or yield. Raising any hook re-arms the quiet timer.

### Notable event hook

`notableEvent` fires for an event of significance `narrative` whose type is in
`narrator.hookOnEvents` (default: `driftingChanged`, `shipLimping`, `contractCompleted`,
`departureRiskAccepted`, `departureHoldLifted`, `departureRepairOutOfReach`, `passengerReturned`,
`fieldSighted`, `fieldEntered`, `shipStuck`), or for an aftermath event of any significance whose
type is in `narrator.aftermathHookOnEvents` (default: `alertCleared`, `navHazard`,
`faultRepaired`). Aftermath events wake the narrator for the conditions its threads wait on:
`alertCleared` once the alert stands down after a field and the crew have reported in,
`navHazard` for a hazard's outcome, `faultRepaired` only for a fault something caused (a
scheduled fault, a hazard scrape, a field impact; never wear) and only off a field's leg. Not
hooked: `problemResolved`, `machineMended`, `hullPlated`, `shipUnstuck`.
Why: the list is a separate key because config filling adds missing keys to old saves but never
merges arrays.

A hookable event is recorded as `narrator.pendingNotable` when committed. Travel raises the hook
from it on the first later tick no hook is pending, then clears it. A story hook raised after the
event clears it too, since that call reads the event; a `stageDock` or the staging hold leaves the
debt standing. Why: a hook raised by travel the tick after the event would otherwise lose it.

### Quiet check-in

`quietTooLong` fires when `narrator.quietTooLongDays` (0.3333, 400 s) pass since the last narrator
contact: the later of the last `narrative` event and the last hook raised of any kind. It runs
last in the tick and yields to any other hook, so a tick raises at most one hook and a check-in
only follows a real silence.

### Policy decision hook

Every kernel-raised decision (the departure gate, repair and safety cards queued through
`queuePolicyDecision`) raises `policyDecision` in the tick it reaches the head of the queue, and
the world does not halt on the decision until that hook has been raised. The host therefore sees
the hook halt first, calls the narrator, and has the card's prose before the modal opens. Job
offers are not hooked: the offer card carries the issuer's pitch. Owner: "anything that requires
a decision gets narrated." Template text is the card's fallback when no narrator answers (offline).

### Staging hook and the hold

`stageDock { portId, dockId, floorSet }` is raised in `transit` once the route left is within
`narrator.approachHookLeadSeconds` (10) at `travel.nominalSpeed` (a drift only delays it; a short
leg raises it on its first tick), at every docking whose port has a dock map, waypoints included.
The record rides on the `transit` and `approaching` stage objects (`TravelState.staging`) and is
spent at `docking`. Transit holds at the end of the route until the hook has been raised and
acknowledged, with or without a plan; the approach needs no engine, so a drift during the hold
does not hold further. If another hook is pending at the lead point the record waits as `due`
and is raised on the first tick none is. A port without a dock map has no hook and no hold.
The only narrator command allowed while it is pending is `stageDock`, and `stageDock` is refused
outside it (`preconditionFailed`; D57 is the owner's ruling for this vocabulary change). Dock
contents and the command are in `dockside.md`.

### Captain ashore ask

`captainAshore { portId, actorId }` is raised once per docking, the tick the captain (or the
command actor, D8) stands on dock floor while looking for work, retried every tick while another
hook is pending. `narrator.captainAshoreLastAsk` records port, tick and who went, and clears when
travel leaves `docked`. The walk and what follows are in `dockside.md`. A port with no dock map
raises the ask on the first idle docked tick. It is a story hook, so raising it settles a
`pendingNotable`; an owed `notableEvent` simply makes the ask retry the next tick.

### Requested call-back

Every story plan carries `callBack { when, why }`, which the translator turns into the
`requestCall` command (allow-listed, D6). `when` is `nextPort` (the default; raises nothing),
`departure` or `midLeg`; `why` is one private line of at most 200 characters, read back on the
call it asked for. `NarratorState.callBack` holds one standing request; every story call's plan
replaces it. Travel raises `requestedCall { when, why, requestedTick }` for `departure` once the
ship has cast off on a stage that started after the request (`departing` or `transit`), and for
`midLeg` at half a hop's transit, per hop, never the whole voyage. A `nextPort` request is served
by the first story hook raised while docked somewhere other than where it was asked. A served
request is cleared when its hook is acknowledged; a replacement applied in the same tick
survives. A request that never comes due stands until the next story call replaces it; the quiet
timer guarantees one. Why: story calls came only at ports, where `scheduleField` and
`scheduleHazard` have no course to schedule on, and the core legs are shorter than the quiet
window.

## The call path

### Browser to model and back

The main thread, which holds the anonymous token, makes the call; the worker only halts and posts
`hookRaised`. It POSTs `{ gameId, hook, snapshot, recentEvents }` to
`/api/games/:id/narrator`, retargets the returned commands to hook tick + 1, and always follows
them with `acknowledgeHook` so the sim resumes. `recentEvents` are the notable and narrative
events since the last story answer (capped at 60, oldest dropped); a staging answer does not clear
them. Card prose is kept on the main thread keyed by decision id; the modal shows template text
(`@crew/content` `templateCard`) until prose arrives. `apps/web` may not import `@crew/narrator`
(`web-no-secrets`), so the reply shape is restated there.

### Narrator route

The route checks the body loosely (the kernel revalidates every command on apply), stores the
snapshot as a milestone save, which is the call's basis, runs the narrator, logs the call in
`narrator_calls` with that basis, and persists the notes. A hook of kind `notes` is refused. The
kind of a call (`story`, `staging`, `notes`) is derived from `hook_kind` (`narratorCallKind`).
Every call is logged, whether ok, error or refused.

### Call spacing

A story call is refused with 429 `budgetExceeded`, `reason: "spacing"`, when its snapshot is
fewer than 100 ticks (`MIN_TICKS_BETWEEN_NARRATOR_CALLS`) after the basis of the last answered
story call. The client acknowledges such a hook with no answer: a refused `quietTooLong` or
`notableEvent` is "no narration this time", and the sim raises both again on its own. Exempt:
`policyDecision`, `captainAshore` and `requestedCall`, which are raised once and would be lost;
staging calls and notes turns, which neither are spaced nor space the next call. A failed attempt
does not count, so a client retry is never "too soon". There is no per-game call cap; the
OpenRouter key's own credit limit guards spending (D102).

### Notes turn

A story call answers with the plan, then runs a second model turn for the notes, which the player
does not wait for. `runNarratorWithTrace` returns the plan with the notes as they stand (stored
notes plus the server-kept changes from this call) and a `notesTurn` that continues the same
conversation: the same cached system prefix, the plan's user turn, the plan as the assistant turn
with the model's `reasoning_details`, then a user turn telling it what became of the plan (each
dropped intent and why). The route logs the story row and a `notes` row (`pending`) before it
responds; the notes turn runs after the response (`waitUntil` on Vercel, inline elsewhere),
stores the notes and finishes the row `ok` or `error`. A call that arrives while a `notes` row is
pending polls (500 ms) for up to `NOTES_TIMEOUT_MS` + 5 s, then reads the notes as they stand; an
older pending row is a cut-off turn and is ignored. A failed notes turn keeps the plan's notes.
The plan reply is the JSON object alone (`PLAN_ONLY` ends the plan's user turn). Why: the notes
are only read by the next call, and two calls rather than one streamed reply was the owner's
choice: no stream parsing, and the notes turn could move to a cheaper model.

### Staging call on the server

A `stageDock` hook runs the staging prompt, schema and translator (`packages/narrator/src/staging/`;
content in `narrator-story.md`) on `CREW_STAGING_MODEL` (default: the story model) at
`CREW_STAGING_REASONING_EFFORT` (default: the story effort), with its own timeout
(§narrator-timeouts). It never writes notes, is never spaced, and is logged like a story call.
In `null` mode the server answers a failed staging call with the floor set (an empty plan) and
logs `[narrator] staging fallback <reason>`.

## Transport and models

### OpenRouter transport

LLM calls go through OpenRouter's OpenAI-compatible chat-completions API (D15); the key is
`OPENROUTER_API_KEY`, and there is no direct Anthropic SDK dependency. The transport is
`openRouterTransport` (`openrouter.ts`) behind the `ModelTransport` interface, so tests inject a
fake. The system prompt is sent as separate static content parts with `cache_control` breakpoints
(at most four, counted back from the last); nothing volatile goes in `system`. A reasoning
model's `reasoning_details` are sent back on the assistant turn of the notes turn, with
`reasoning.context: "all_turns"` when an effort is set (they are billed as input).

### Plan schema in the prompt

The plan's JSON schema is the last system block (`schemaInstruction`, game-independent so it stays
in the cached prefix); the transport sends no `response_format`. `runNarrator`'s zod validation of
every reply is the only check, and a reply that fails it falls back `schemaInvalid` (a fence
around the JSON is tolerated). Per-game ids (ports, items, machines, faults, stores) are plain
strings validated by the translator, with drop reasons fed back to the model; the capabilities
block lists the valid ids. Why (D53): strict structured output compiles the schema into a grammar
with a provider-side size cap the plan outgrew three times, and OpenRouter sends a `json_schema`
to Anthropic as a grammar even with `strict: false`. A schema-size test holds the schema to a
prompt-token budget (8 KiB) and keeps per-game ids out of the cached prefix.

### Models and reasoning effort

`DEFAULT_NARRATOR_MODEL` is `openai/gpt-6-luna` and `DEFAULT_NARRATOR_REASONING_EFFORT` is `low`
(`packages/narrator/src/run.ts`); the server and the live suite both read them. Overrides:
`CREW_NARRATOR_MODEL`, `CREW_NARRATOR_REASONING_EFFORT`, `CREW_STAGING_MODEL`,
`CREW_STAGING_REASONING_EFFORT`. The effort is sent as OpenRouter's `reasoning.effort`; `default`
sends nothing. Set it per model: on one that does not reason by default, any effort switches
thinking on and makes the call slower. Why: latency tracked output tokens, and most of those were
hidden reasoning.

### Narrator timeouts

`NARRATOR_TIMEOUT_MS` 25 s for a story call (Vercel's function budget is about 30 s), no retry
inside the call; `STAGING_TIMEOUT_MS` 10 s for a staging call (`CREW_STAGING_TIMEOUT_MS`
overrides, and the route passes it only for staging); `NOTES_TIMEOUT_MS` 45 s for the notes turn.
The browser gives up on a request at 30 s. Why: a staging attempt that ran long held the ship at
the end of transit on every retry.

## Failure and retries

### No offline narrator for players

`CREW_NARRATOR_FALLBACK` is `error` in production and `null` elsewhere (D43). In `error` mode a
model failure is never a template card: the route answers 503 `narratorUnavailable`
(`notConfigured`, not retryable) or 502 (any other `FallbackReason`: `apiError`, `timeout`,
`refusal`, `truncated`, `schemaInvalid`; retryable), and logs the call as an error with the
reason. The null narrator is for tests and explicit offline use: it answers `policyDecision` with
a template card, `captainAshore` with one templated job offer (the narrator is the only source of
work), and `stageDock` with an empty plan.

### Story retry schedule

The browser classifies each failure (`classifyFailure`) as `retryable`, `fatal` or `spacing`. The
hook stays unacknowledged, so the sim stays halted, while it retries after 2, 4, 8, 16 and 30 s
(`RETRY_DELAYS_MS`, `narratorRetry.ts`, a pure state machine the host drives). A fatal failure
(`notConfigured`, a rejected request), or the schedule running out, pauses the game on an error
panel with the reason and a Retry button, which starts the sequence over from attempt 1. A 429
that is not `spacing` is a retryable failure. Only `spacing` acknowledges a hook with no answer.
Owner: "retry/delay or in the worst case pause the game with an error message."

### Staging retries and the floor set

Staging never ends on the error panel (D57's exception to D43). A transient failure retries after
2 s and 4 s (`STAGING_RETRY_DELAYS_MS`); when those run out, or the failure is fatal, the hook is
acknowledged with no plan and the dock is the floor set, with `[narrator] staging fallback
<reason>` in the console. Why: the sim is halted on the call, so the story schedule held the ship
visibly at the end of transit.

### Live narrator tests

`pnpm test:live` (`packages/narrator/src/live/`, root `vitest.live.config.ts`) makes one real
OpenRouter call per hook kind through the production transport, prompt and schema, and fails on
any fallback, printing the provider's error text. It reads the key from `OPENROUTER_API_KEY` or
`packages/narrator/.env.local`, is skipped without one, and is excluded from `pnpm test`. Run it
before deploying prompt, schema or transport changes. Why: the unit suite cannot see a provider
rejecting the request, and production once failed every call while `pnpm test` was green.
