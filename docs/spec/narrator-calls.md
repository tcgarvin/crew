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
`fieldSighted`, `fieldEntered`, `shipStuck`, `jobFailed`, `expeditionResolved`), or for an
aftermath event of any significance whose
type is in `narrator.aftermathHookOnEvents` (default: `alertCleared`, `navHazard`,
`faultRepaired`). Aftermath events wake the narrator for the conditions its threads wait on:
`alertCleared` once the alert stands down after a field (never a fight's) and the crew have
reported in, `navHazard` for a hazard's outcome, `faultRepaired` only for a fault something caused
(a scheduled fault, a hazard scrape, a field impact; never wear) and only off a field's leg. Not
hooked: `problemResolved`, `machineMended`, `hullPlated`, `shipUnstuck`.
Why: the list is a separate key because config filling adds missing keys to old saves but never
merges arrays. For the same reason a game saved before errands existed never hooks `jobFailed` or
`expeditionResolved`; it can still take an errand, and the closing card then waits for the
narrator's next call.

A hookable event is recorded as `narrator.pendingNotable` when committed. Travel raises the hook
from it on the first later tick no hook is pending, then clears it. A story hook raised after the
event clears it too, since that call reads the event; a `stageDock` or the staging hold leaves the
debt standing. Why: a hook raised by travel the tick after the event would otherwise lose it.

### Quiet check-in

`quietTooLong` fires when `narrator.quietTooLongDays` (0.3333, 400 s) pass since the last narrator
contact: the later of the last `narrative` event and the last hook raised of any kind. It runs
last in the tick and yields to any other hook, so a tick raises at most one hook and a check-in
only follows a real silence. A standing call-back request with `holdQuiet` doubles the window
(§requested-call-back).

### Policy decision hook

Every kernel-raised decision (§policy-decision-cards) raises `policyDecision` in the tick it
reaches the head of the queue, and the world does not halt on the decision until that hook has
been raised. The host therefore sees the hook halt first, calls the narrator, and has the card's
prose before the modal opens; template text is the fallback when no narrator answers. Job offers
are not hooked: the offer card carries the issuer's pitch. Owner: "anything that requires a
decision gets narrated."

### Staging hook and the hold

`stageDock { portId, dockId, floorSet }` is raised in `transit` once the route left is within
`narrator.approachHookLeadSeconds` (10) at `travel.nominalSpeed` (a drift only delays it; a short
leg raises it on its first tick), at every docking whose port has a dock map, waypoints included.
The record rides on the `transit` and `approaching` stage objects (`TravelState.staging`) and is
spent at `docking`. Transit holds at the end of the route until the hook has been raised and
acknowledged, with or without a plan; the approach needs no engine, so a drift during the hold
does not hold further. If another hook is pending at the lead point the record waits as `due`
and is raised on the first tick none is. A port without a dock map has no hook and no hold.
While it is pending only `stageDock` is accepted from the narrator (§staging-plan-command).

### Captain ashore ask

`captainAshore { portId, actorId }` is raised once per docking, the tick the captain (or the
command actor, D8) stands on dock floor while looking for work (§looking-for-work), retried every
tick while another hook is pending. `narrator.captainAshoreLastAsk` records port, tick and who
went, and clears when travel leaves `docked`. A port with no dock map
raises the ask on the first idle docked tick. It is a story hook, so raising it settles a
`pendingNotable`; an owed `notableEvent` simply makes the ask retry the next tick.

### Requested call-back

Every story plan carries `callBack { when, why, holdQuiet }`, which the translator turns into the
`requestCall` command (allow-listed, D6). `when` is `nextPort` (the default; raises nothing),
`departure`, `midLeg`, `arrival` or `afterCard`; `why` is one private line of at most 200
characters, read back on the call it asked for. `NarratorState.callBack` holds one standing
request; every story call's plan replaces it. Travel raises `requestedCall { when, why,
requestedTick }` for `departure` once the ship has cast off on a stage that started after the
request (`departing` or `transit`), and for `midLeg` at half a hop's transit, per hop, never the
whole voyage. `arrival` comes due at the approach lead point (`narrator.approachHookLeadSeconds`
of route left at `travel.nominalSpeed`, where §staging-hook-and-the-hold raises `stageDock`), and
stays due through `approaching` and `docking` while another hook holds it: at a port with a dock
map the staging call comes first and the arrival call the tick after it is answered. Asked past
that point of the leg in flight (`CallBackRequest.afterDocking`), it means the next leg's, from the
ship's next docking. `afterCard` comes due the tick after a card is answered with no follow-up to
come (`cardResolvedTick`, written by `resolveDecision`; §follow-up-cards), docked or not.
`holdQuiet: true` doubles the quiet window (§quiet-check-in) while the request stands, which is
until the next story call replaces it: the narrator owns its own quiet (D46). A `nextPort` request is served
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
them. Card prose is kept on the main thread keyed by decision id; it is presentation only, the sim
holding the decision, and the modal shows template text (`@crew/content` `templateCard`) until
prose arrives, or for good if none does. `apps/web` may not import `@crew/narrator` or
`@crew/server` (`web-no-secrets`), so the reply shape is restated there.

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
dropped intent and why) and what the plan needs now, by the moment and never by advice
(§seasons-and-stalls). The notes turn, and only it, offers read-only tools (§notes-turn-tools),
which it may call before it answers; the reply after them is the notes. The route logs the story row and a `notes` row (`pending`) before it
responds; the notes turn runs after the response (`waitUntil` on Vercel, inline elsewhere),
stores the notes and finishes the row `ok` or `error`. A call that arrives while a `notes` row is
pending polls (500 ms) for up to `NOTES_TIMEOUT_MS` + 5 s, then reads the notes as they stand; an
older pending row is a cut-off turn and is ignored. A failed notes turn keeps the plan's notes.
The plan reply is the JSON object alone (`PLAN_ONLY` ends the plan's user turn). Why: the notes
are only read by the next call, and two calls rather than one streamed reply was the owner's
choice: no stream parsing, and the notes turn could move to a cheaper model.

### Notes-turn tools

The notes turn may read what the digest leaves out by calling tools before it writes its notes
(`notes-tools.ts`), over what the server already holds for the call: the snapshot, the stored
notes as the digest showed them, and the request's recent events. All are read-only and answer in
compact text (each tool keeps itself under about 1,900 characters; the loop cuts any result at
`MAX_TOOL_RESULT_CHARS` 2,000):

- `pastArcs(scale?)`: the past arcs (§past-arcs), newest first, optionally one scale.
- `thread(title)`: an open thread in full (scale, people, arc notes, next beat, ticks, the plan
  beats whose `thread` names it), or an ended one's past arc.
- `castMember(name)`: everything held on someone not crew: the cast entry, where they are a
  port's local or a site's default person, the jobs they offered, and the open threads, past arcs
  and cards they appear in. A crew name is pointed at `crew`.
- `site(id)`: a port or site by id or name: description, character, locals, the cast placed there,
  its dock or site map's posts and default people, and the "On the dock" or "At the site" lines
  when the ship is alongside it.
- `cardsShown(n)`: the last `n` cards (1 to 50) of the card history; asked for more than it holds,
  it says it keeps the last 12 (§card-history) and how many it has.
- `crew(name)`: one crew member's full digest line (§crew-lines), or a passenger's "Aboard" line,
  by full, first or last name.
- `eventsSince(tick, type?)`: the request's events since the tick, oldest first (trace events only
  when asked for by type), with the span the request holds: events since the last story call.

An unknown tool, arguments that are not JSON or fail the tool's schema, and a name, title, id or
type that matches nothing each answer with what was wrong and what exists ("No such thread … Open
threads: …"), never an exception.

The loop is `callForValidReply`'s (`model-call.ts`; a transport stays one round trip): while tools
are offered (`tool_choice: "auto"`) and the reply asks for tool calls, each call is run (at most
`MAX_TOOL_CALLS_PER_ROUND` 6 a round; any more are answered "not run"), the reply goes back as an
assistant turn with its `tool_calls` and `reasoning_details`, each result as a `tool` turn, and the
model is called again. Tools are callable for at most `CREW_NARRATOR_TOOL_ROUNDS` rounds
(`DEFAULT_MAX_TOOL_ROUNDS` 4; 0 offers none and leaves the tools line out of the notes request) and
only while at least `TOOL_RESERVE_MS` (20 s) of the notes turn's `NOTES_TIMEOUT_MS` is left, the
time the notes JSON itself needs. Past either limit the next call declares the tools with
`tool_choice: "none"` (a conversation holding tool calls must still declare them) and, if the model
has called any, adds a user turn opening `# No more tools` that asks for the JSON object only. The
reply that asks for no tool call is the one validated; a malformed one is repaired as any other
(§repair-turn), in the same conversation with the tool turns kept, and a repair offers no tools.
A provider that refuses the request for its tools (OpenRouter 400, 404 or 422 naming tools:
`ToolsRejectedError`) is asked again at once without them and without any tool turns, and logs
`[narrator] tools rejected`; the notes turn does not fail for it.

Each call logs `[narrator] tool` (game, call, round, name, arguments, result length), and closing
the tools logs `[narrator] tools closed` (why, rounds). The calls (`{ round, name, arguments,
resultChars, result }`, the result cut to 300 characters) ride in the notes row's
`narrator_calls.response` jsonb as `toolCalls`, beside `repairs`; usage sums every round. The
system rules ("Your notes") say the tools exist, that they belong to the notes turn only, when to
use them (revising a season or an arc, bringing back a cast member or an old arc, checking who a
beat falls on; most turns need none), and that the turn ends with the notes JSON alone; the notes
request repeats it in a line when tools are offered. The story plan call stays one-shot, with no
tools: it is on the player's wait (§narrator-timeouts). Why: the owner's "Plan at the usual time.
Might need to make the planning agent more powerful (ie tool use) to be able to do everything
we're asking it", read-only tools first (narrator arcs §6.7): the turn asked to think across the
whole game had only the plan call's budget-trimmed digest. Rejected: declaring the tools on the
plan call too with `tool_choice: "none"`, which would keep the notes turn's whole prefix cached
from the plan call, but puts the tool definitions and a provider's refusal of them on the
player's wait. The tools sit before the system blocks in the cached prefix, so the notes turn
reads its static prefix from the cache of earlier notes turns rather than from the plan call.

### Staging call on the server

A `stageDock` hook runs the staging prompt, schema and translator (`packages/narrator/src/staging/`,
§staging-prompt) on `CREW_STAGING_MODEL` (default: the story model) at
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
`reasoning.context: "all_turns"` when an effort is set (they are billed as input). The notes turn
sends OpenAI-style function `tools` with `tool_choice` (`auto`, or `none` once they are closed);
a reply's `tool_calls` come back as the result's tool calls (`finish_reason: "tool_calls"`), and go
out again as an assistant turn with `tool_calls` and its `reasoning_details`, each answered by a
`tool` message (§notes-turn-tools). Every other call sends no `tools`.

### Plan schema in the prompt

The plan's JSON schema is the last system block (`schemaInstruction`, game-independent so it stays
in the cached prefix); the transport sends no `response_format`. `runNarrator`'s zod validation of
every reply is the only check; a reply that fails it is handed back to the model to fix
(§repair-turn), and falls back `schemaInvalid` only when that fails too (a fence around the JSON
is tolerated). Per-game ids (ports, items, machines, faults, stores) are plain
strings validated by the translator, with drop reasons fed back to the model; the capabilities
block lists the valid ids. Why (D53): strict structured output compiles the schema into a grammar
with a provider-side size cap the plan outgrew three times, and OpenRouter sends a `json_schema`
to Anthropic as a grammar even with `strict: false`. A schema-size test holds the schema to a
prompt-token budget (12 KiB) and keeps per-game ids out of the cached prefix.

### Models and reasoning effort

`DEFAULT_NARRATOR_MODEL` is `openai/gpt-6-luna` and `DEFAULT_NARRATOR_REASONING_EFFORT` is `low`
(`packages/narrator/src/run.ts`); the server and the live suite both read them. Overrides:
`CREW_NARRATOR_MODEL`, `CREW_NARRATOR_REASONING_EFFORT`, `CREW_STAGING_MODEL`,
`CREW_STAGING_REASONING_EFFORT`, and `CREW_NOTES_MODEL`, `CREW_NOTES_REASONING_EFFORT` for the
notes turn alone (§notes-turn; unset = the story call's, the route passes them only on story
calls). The notes turn hands back the plan turn's `reasoning_details`, so a notes model other
than the story's reads another model's reasoning. The effort is sent as OpenRouter's `reasoning.effort`; `default`
sends nothing. Set it per model: on one that does not reason by default, any effort switches
thinking on and makes the call slower. Why: latency tracked output tokens, and most of those were
hidden reasoning.

### Narrator timeouts

`NARRATOR_TIMEOUT_MS` 25 s for a story call (Vercel's function budget is about 30 s), no retry
inside the call (a §repair-turn is not a retry: it spends the same budget);
`STAGING_TIMEOUT_MS` 10 s for a staging call (`CREW_STAGING_TIMEOUT_MS` overrides, and the route
passes it only for staging); `NOTES_TIMEOUT_MS` 45 s for the notes turn, its tool rounds
(§notes-turn-tools) and repairs included. The browser gives up on a request at 30 s.
Why: a staging attempt that ran long held the ship at the end of transit on every retry.

## Failure and retries

### No offline narrator for players

`CREW_NARRATOR_FALLBACK` is `error` in production and `null` elsewhere (D43). In `error` mode a
model failure is never a template card: the route answers 503 `narratorUnavailable`
(`notConfigured`, not retryable) or 502 (any other `FallbackReason`: `apiError`, `timeout`,
`refusal`, `truncated`, `schemaInvalid`; retryable), and logs the call as an error with the reason.
A malformed reply is first repaired inside the call (§repair-turn); `schemaInvalid` means the
repairs failed or there was no time for one. The null narrator is for tests and explicit offline
use: it answers `policyDecision` with a template card, `captainAshore` with one templated job offer
(the narrator is the only source of work), and `stageDock` with an empty plan.

### Repair turn

A model reply that is empty, not JSON, or fails its schema (`schemaInvalid`) is not a failure
yet: the call goes back to the model in the same conversation, the same cached system prefix and
first user turn, then the model's reply as the assistant turn (with its `reasoning_details`; an
empty reply is left out) and a user turn that opens `# Your reply could not be used` and lists
what was wrong: "Your reply was empty.", "Your reply was not valid JSON (<parser message>).", or
each zod issue as `at <path>: <message>` (at most 20, then a count). An intent matching no branch
of the intent union is spelled out: the missing or wrong fields of the kind it named, or the kinds
allowed when it named none. The turn asks for the complete corrected JSON object only. This
applies to the story plan, the notes turn (§notes-turn) and the staging call; the notes turn
continues the plan's whole conversation, repairs included. In the notes turn the reply repaired is
the one after any tool rounds, and the repair keeps the tool turns (§notes-turn-tools).

A call makes at most `CREW_NARRATOR_REPAIRS` repairs (`DEFAULT_MAX_REPAIRS` 2; 0 turns them off),
all inside the call's own timeout (§narrator-timeouts): each attempt gets only what is left, and a
repair is asked only when the time left is at least `MIN_REPAIR_MS` (4 s) and at least as long as
the failed attempt took, since the fix is the whole reply again. Out of repairs or time, the call
fails `schemaInvalid` as before and the retry schedules below apply. A repair that itself times out
or is refused fails with that reason. No other failure is repaired, `truncated` included. Each
repair logs `[narrator] repair` (game, call, schema, attempt, time left, issues), and the call's
repairs (`{ attempt, problems }`) ride in its `narrator_calls.response` jsonb as `repairs` (on an
error row, the response is `{ repairs }`); usage sums every attempt. A translator drop is not
`schemaInvalid` and is never repaired; it is fed back on the next call
(§translation-and-drop-reasons). Why: a malformed reply used to cost the browser a whole new call
from scratch. Owner: "I don't think the call should fall back if it's a malformed result. I think we
should call the model back with what was wrong, and let the model respond with a fixed version."

### Story retry schedule

The browser classifies each failure (`classifyFailure`) as `retryable`, `fatal` or `spacing`. The
hook stays unacknowledged, so the sim stays halted, while it retries after 2, 4, 8, 16 and 30 s
(`RETRY_DELAYS_MS`, `narratorRetry.ts`, a pure state machine the host drives). A fatal failure
(`notConfigured`, a rejected request), or the schedule running out, pauses the game on an error
panel with the reason and a Retry button, which starts the sequence over from attempt 1. A 429
that is not `spacing` is a retryable failure. Only `spacing` acknowledges a hook with no answer.
Owner: "retry/delay or in the worst case pause the game with an error message." A
`schemaInvalid` failure reaches this schedule only after the server's repairs (§repair-turn).

### Staging retries and the floor set

Staging never ends on the error panel (D57's exception to D43). A transient failure retries after
2 s and 4 s (`STAGING_RETRY_DELAYS_MS`); when those run out, or the failure is fatal, the hook is
acknowledged with no plan and the dock is the floor set alone (§staging-plan-dressing), with
`[narrator] staging fallback <reason>` in the console. Why: arrival is never held for a failing
narrator; the sim is halted on the call, so the story schedule held the ship visibly at the end of
transit.

### Live narrator tests

`pnpm test:live` (`packages/narrator/src/live/`, root `vitest.live.config.ts`) makes one real
OpenRouter call per hook kind through the production transport, prompt and schema, and fails on
any fallback, printing the provider's error text. It reads the key from `OPENROUTER_API_KEY` or
`packages/narrator/.env.local`, is skipped without one, and is excluded from `pnpm test`. Run it
before deploying prompt, schema or transport changes. Why: the unit suite fakes every transport, so
a provider rejecting the real request left production failing while `pnpm test` was green. Owner:
"a suite of LLM tests to use not all the time, but for these kinds of situations."

The plan-quality harness (`plan-quality.live.test.ts`) sits beside it and is skipped unless
`CREW_PLAN_SAMPLES` is set: it samples the notes turn's season, arc and episode sketches that many
times on three digests (game start, an episode opening under a standing season and arc, thin
notes with a season to sketch), prints them with the plan's intents, and writes them to
`CREW_PLAN_OUT` as JSON, with each turn's latency and tokens; `CREW_NOTES_REASONING_EFFORT` sets
the notes turn's effort, so efforts can be compared. It asserts only that the notes parse; the judging is by reading. Run it
(`CREW_PLAN_SAMPLES=3 pnpm exec vitest run --config vitest.live.config.ts plan-quality`) before
and after a change to the plan's prompt text (§the-plan).
