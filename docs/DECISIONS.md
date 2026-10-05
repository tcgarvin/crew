# Decisions

Append-only log of rule and architecture decisions with rationale. Newest at the bottom.
Owner = project owner. Where the owner overruled a design-partner recommendation, that is noted.

## 2026-09-30 — Founding decisions

**D1. TypeScript end-to-end.** Kernel is a pure package with no runtime dependencies so it runs
identically in a browser worker and in Node. Checked that the Anthropic TS SDK has full parity
with Python (streaming, tool runner, structured outputs, caching, batches); nothing the Narrator
needs is Python-only.

**D2. Vercel + Neon; Vite SPA + Node functions; no Next.js.** A canvas game plus a JSON API gains
nothing from RSC/ISR.

**D3. Simulation runs in the browser (Web Worker).** The save is the serialized state blob.
Owner: "okay with running everything in the front end… we could move stuff between front and back
end easily later." The kernel is host-agnostic; a Node host exists for headless tests.

**D4. Determinism is not a goal.** Owner: "The determinism is not important… we're going to spend
a lot of time debugging the implementation of sin." Dropped: replay from inputs, state hashes,
cross-engine determinism, `dmath`, golden-hash tests. Kept (near-zero cost, aids bug reports and
stable tests): seeded `sfc32` streams stored in state, no `Math.random`/`Date` inside the kernel,
JSON-safe state. Overrules review §A.7 risk 2, §C.9, §C.10.

**D5. Narrator is hook-driven and synchronous.** The sim pauses at authored hook points, the UI
shows a loading state, the server calls the LLM, returned commands apply at the pause tick.
Owner: "I don't think we need to solve latency right now." Drops review §A.4/§D.4 windows,
`validUntilTick`, cadence table. Preconditions are still validated at apply time.

**D6. Narrator authority is a mechanical allow-list**, not a prompt instruction (kept from review
§D.3): boundary spawns only, faults on machines only with the kernel sampling the tick, messages
through in-world channels, jobs within config price bands, decisions, bounded soft-state nudges.
No command exists to set body/health/position/knowledge/money directly.

**D7. The player's map shows truth.** Owner decision. One render layer. A per-person "what do
they see" view is a possible later feature. The AgentView boundary stays because it drives crew
behavior (SD §4.3), not because of rendering.

**D8. When the captain is asleep or incapacitated, player perspective jumps to the first
officer.** Owner decision.

**D9. No save-scumming.** One linear timeline per game.

**D10. Time is a gameplay knob, not a fictional ratio.** Owner: "It's not about measuring time…
it just has to be playable." Docking a few seconds; short hop ≤ ~30 s; long hops longer and
expected to carry events; needs tuned to a 10–30 minute session. No sim-second→fictional-time
mapping is defined and none is required to be self-consistent.

**D11. Narrator vocabulary for the first build is discovered together.** No combat, so the
prompt lists what the sim can currently do and grows with it.

**D12. V1 is one thin vertical slice, not sequential milestones.** Owner: systems are
"bottomless… we don't need to explore them all to the nth degree to get our test." Target: crew
moving and working, a few breakable systems, three ports and a freight loop, a visible narrator
hook, the decision modal. Deferred list in `PLAN.md` §7.

**D13. Content is data from day one.** Zod schemas → JSON; hand-authored and LLM-generated content
share one validator. Generated ships/crews/images are post-V1.

**D14. Run-ahead with buffered playback (owner proposal).** The worker simulates ahead of the
viewer up to a cap (~60 sim-seconds) and stops at the next hook; the main thread plays buffered
frames at human speed. Narrator calls fire when the worker reaches a hook, so their latency
overlaps the viewer's catch-up time. Safe without determinism because the sim runs exactly once;
the viewer only watches a delayed stream. **Depends on:** player input occurring only at hooks
(decisions), where the sim is paused — any future direct player input must itself be a hook.
Costs accepted: the inspector reads from a ring of view-time snapshots (not the ahead-state) so
the future never leaks; on reload the viewer snaps to the saved ahead-state. Built after the plain
real-time host works; the worker↔main protocol is designed for it from W0.

**D15. LLM calls go through OpenRouter.** Owner decision (2026-09-30). The narrator uses the
OpenAI-compatible chat-completions API at openrouter.ai with `response_format: json_schema`;
model is configurable (`CREW_NARRATOR_MODEL`), key is `OPENROUTER_API_KEY`. No direct
Anthropic SDK dependency. Vercel is managed through the Vercel connector (MCP), not the CLI,
where possible; Neon is attached from the dashboard because the connector token cannot manage
Marketplace integrations. Vercel project: `crew` in team `tims-projects-6bc94f1b`.

## 2026-09-30 — Integration 2

Made while wiring every system into the deployed build. Each is small and reversible; the owner
should confirm or overrule.

**D16. One job offer at a time; accepting sets course.** The deterministic job source used to
refill the board whenever fewer than `boardSize` offers were open, and every offer surfaces a
decision, so a host that answers decisions at once saw a new offer (and on accept a new manifest)
every tick. Now it offers one job at a time and stays quiet while an offer or job decision is
open, while an accepted job has not left port, for `commerce.reofferSeconds` after a decline or
expiry, and while a course is planned. The "Take the job" side also carries `setCourse` to the
job's destination. `setCourse` with freight still moving plans the course and stays docked with
the ramp open; the travel system departs when the last `cargoToLoad`/`cargoToUnload` problem is
resolved. `boardSize` is currently unused. `jobBoard` hook fires only when the source is free to
offer but has nothing to offer.

**D17. Crew start with needs drawn from `config.needs.initialRange`** (the `setup` stream), so
the first minutes have motion.

**D18. Sensor-channel symptoms are public.** A fault whose symptom channel is `sensor` (e.g. the
engine's stall warning) is visible to everyone at once, like a panel alarm; audible and visual
symptoms still need someone in the compartment. Faults injected by the scenario path now also get
their symptom problem (the equipment tick opens one for any undiagnosed fault without one).

**D19. Engine and generator no longer overheat in normal running.** Cooling is a flat rate, so
any machine whose rise beat its cooling would reach 1.0 and stop. The engine now cools 0.025/s
against a 0.02/s rise, the generator 0.02/s against 0.015/s. Heat now comes from faults
(`overheat` effects) and a coolant pump that is down (cooling ×0.2).

**D20. A save made with other content still loads.** `restore` no longer throws on a content hash
mismatch; it reports it in `warnings` and restores against the loaded content, so tuning content
does not wipe saves. A schema version mismatch without a migration still fails.

**D21. `notableEvent` sees every narrative event.** Phase 8 records the last `narrative` event of
each tick (preferring one listed in `narrator.hookOnEvents`), and travel raises the hook from it
the next tick. Default `hookOnEvents`: `driftingChanged`, `contractCompleted`.

**D22. The narrator is called from the main thread.** The worker halts at a hook and posts
`hookRaised`; the main thread (which holds the anonymous token) POSTs the snapshot, forwards the
returned commands at hook tick + 1 and always sends `acknowledgeHook`, on failure too, with a
"narrator unavailable" toast. Card prose is kept on the main thread keyed by decision ID; the
modal shows template text (`@crew/content` `templateCard`) until prose arrives. Default server
narrator model: `anthropic/claude-sonnet-4.6` when `CREW_NARRATOR_MODEL` is unset.

**D23. The API ships as a bundled Build Output API function** (`scripts/vercel-output.mjs`), not
a zero-config `api/` file: see `docs/DEPLOYMENT.md` "The Vercel function".

## 2026-09-30 — After the owner's first phone playtest

**D24. Cards never mention pay.** Owner: "pay hints are not that interesting." Offers describe the
job and the person offering it; money appears only in the top bar.

**D25. Job offers come from people, not companies.** Every `offerJob` carries an `issuer` person
(name, role, organisation) and a `pitch` line of dialogue. The narrator writes them and keeps them
in its cast so they can recur (GDD §21); the null job source draws from a name table so offline
play has the same shape.

**D26. Reigns-style aftermath.** Every decision option carries a one-line aftermath caption
shown for a moment after the choice and before the card closes, stating what happens next in
plain terms. Template text by default; narrator prose when available. Owner: "when I declined a
job, it really wasn't sure what was going to happen next."

**D27. Ship headline.** A persistent one-line status derived from state (travel stage,
destination, ETA, loading progress, waiting for work) sits under the top bar. The ticker is
secondary. Owner: "not clear what's happening at the top level."

**D28. Cargo and rooms are visible.** Items render on deck and on the carrier; compartments get
distinct fills and drawn walls. Re-offer cooldown after a decline drops from 60 s to 20 s.

## 2026-10-01

**D29. Cards are spoken, not narrated.** Owner, after reviewing a "Jax and Priya's Argument"
card: cards are now brought to the captain by a named person in their own words (grievances from
the crew member concerned, operational matters from the first officer, offers from the issuer),
Reigns-style, with a `speaker` field so a face can be shown later. Situation cap raised from 60
to 70 words with a 35 to 55 target; side labels are what the captain says or does. Prompt v0.3.

**D30. The worker actually runs ahead.** The D14 loop advanced at wall-clock rate, so the lead
was always ~0 and every hook stalled the viewer for the full narrator round trip. The worker now
bursts `burstTicksPerLoop` ticks per loop iteration (measured: ~0.3 ms/tick on the default
scenario → default 40) until the 60 s cap, emitting a frame every `frameEveryTicks` ticks (default
2) so playback interpolation stays smooth, and rebuilds the lead after every hook. Owner: "waiting
for the narrator ... feels like we're waiting the entire cycle."

**D31. The narrator knows what the captain has seen.** Owner, after three resupply cards in a
row, the third re-asking a detail of the second: the server keeps an exact history of the cards
shown and the side chosen (`cardsShown` in the narrator's notes, maintained in `run.ts` from the
call's own card and `surfaceDecision` output plus the kernel's `decisionPending` and
`decisionResolved` events; never model-written), shown in the digest as "What the captain has
seen". A card must bring something the captain has not seen on a card (new information, a new
person, a consequence, the next beat of a thread) or the narrator does nothing. No card spacing
rule and cards need not be trades: minor crew cards are welcome. `decisionResolved` carries only
the decision ID, so a narrator-surfaced card (which has no ID until the kernel mints one) is
matched to its decision by title through the decision record kept in the snapshot.

**D32. Threads are structured, TV-style.** Open threads (`threads`, replacing the free-text
`openThreads`) carry a scale (beat: one card with a follow-up; episode = one complete story, usually a
job's length, typically opening with the captain looking for work, the narrator deciding what the
crew runs into; a boarding attempt while docked is an episode with no job in it; season: returns every few
jobs; series: a slow pressure that surfaces rarely), the people in
them, a stage sentence, a next-beat condition and the tick of the last beat (server-kept: the
hook tick whenever a card or offer this call named one of the thread's people). Two to four
alive at different scales; a thread returns only when its condition holds and something has
changed. Old notes migrate each string into an episode thread. Prompt v0.4.

**D33. Narrator log CLI.** `pnpm --filter @crew/server narrator-log` reads `narrator_calls`
read-only from a locally supplied `DATABASE_URL` and can rebuild the digest a call saw, so card
problems are debugged from the record rather than screenshots. The credential is never printed.

**D34. The headline never narrates.** Owner: the docked headline said "<issuer> is offering freight
for <port>", a story claim the narrator never made, hardcoded in the sim. Docked with no cargo work
now reads "looking for work" whether or not an offer is open; offers are the card's to tell.

**D35. Integrity affects output.** Owner, after the generator showed "bad shape" and the ship
flew anyway: output now derates linearly below `equipment.integrityDerateBelow` (0.5) and the
machine is inoperable below `equipment.integrityInoperableBelow` (0.15) until repaired; a
completed fault repair restores integrity to at least the derate threshold (the only path that
restores it; overheat is the only thing that costs it). A blocked machine renders as "failed". A
derating `coil_burnout` fault (stator coil burnout, output ×0.35, sensor symptom) joins the
generator's content.

**D36. Departure gate, asked once.** A planned departure with an impaired engine or generator
(blocked, a derating/disabling fault unrepaired, or output below `travel.departureMinOutput`,
0.5) raises one policy decision, "Hold for repairs" / "Leave anyway", brought by the engineer
(D29). Hold keeps the planned course, waits for the repair and departs on its own
(`departureHoldLifted`); leave anyway (`departureRiskAccepted`) is remembered until the next
docking. Both events are in the default `hookOnEvents`. Owner: "careful that we don't bother the
player every time a single system isn't 100%": symptoms, warm panels and moderate integrity never
trigger it.

**D37. Every policy decision is narrated.** Kernel-raised decisions (the departure gate, and any
future repair or safety card queued through `queuePolicyDecision`) now raise a `policyDecision`
hook first, in the tick they reach the head of the queue (`decisionPendingSystem`), and the
world does not halt on such a decision until its hook has been raised (`haltReason`), so the
host always sees the hook halt before the decision halt, calls the narrator, and has the card's
prose keyed by decision id before the modal opens. Template text remains the fallback when the
narrator fails or is offline. The digest's hook line names the machine and the template speaker
(the engineer for the gate) so the model dresses the card in that voice. Policy hooks are exempt
from the server's minimum tick spacing (not the hourly cap). Job offers are not hooked: the
offer card already carries the issuer's pitch (D25). Owner: "anything that requires a decision
gets narrated."

**D38. Crew have voices, not wants.** Each crew member carries a `voice` (how they talk and
handle the captain), shown in the digest; the narrator writes them in it and shares the stage
across the crew. Owner deferred "wants": those surface as threads, not as a sheet.

**D39. Arc selection and beat cards.** When several threads are ready, the oldest-beat thread
goes first unless an episode is at its climax. A beat card (Reigns-style) advances a thread
without a decision: both sides are the captain's attitude, recorded into the thread; one per
thread before its payoff, enforced by the translator. Prompt v0.5.

**D40. The narrator is the only source of work.** The sim's deterministic job source is gone (it
ran in production alongside the narrator, refilling the board from port templates after every
decline). `jobBoard` now fires once per docking when the captain has no offer, no job and no
course (and not within `commerce.reofferSeconds` of a declined or expired offer at that port);
the narrator answers it, and the null narrator answers it offline (and on every fallback) with
one templated offer through the same translator. `commerce.boardSize` is removed. Prompt v0.6.
Owner: "let the narrator figure that out dynamically as part of its arc generation."

**D41. The captain never speaks on a card.** The `captain`-tagged crew member is the player's
avatar (Mara Osei today; others later). They keep a voice for how they come across, shown to the
narrator, but the translator nulls them as a speaker (the card survives as an observed scene and
the reason is fed back under "rejected last time"). Prompt v0.7.

**D42. Offer cards wait for the dock; failures are visible.** An offer surfaced on approach is
shown once the ship is docked at its port so "Take the job" can succeed; narrator fallbacks are
logged with their reason; rejected player commands raise a toast. Prompt v0.8.

**D43. No offline narrator for players.** `CREW_NARRATOR_FALLBACK` defaults to `error` in
production: a model failure is an error, never a template card. The route answers 503
`narratorUnavailable` (`notConfigured`, not retryable) or 502 (any other fallback reason,
retryable), and its 429s say whether the hourly cap or the tick spacing fired. The client
retries with backoff (2, 4, 8, 16, 30 s; the hourly cap is waited out in 30 s steps for up to
5 minutes) while the sim stays halted (the run-ahead lead hides the first retries), then pauses
the game on an error panel with the reason and a Retry button. Only the spacing rule still
acknowledges a hook without an answer: that is a rate rule, not a failure. The null narrator
remains for tests and explicit offline use (`CREW_NARRATOR_FALLBACK=null`, the default outside
production). Owner: "retry/delay or in the worst case pause the game with an error message."

**D44. Live narrator tests.** `pnpm test:live` makes one real OpenRouter call per hook kind
through the production transport, prompt and schema, and fails on any fallback, printing the
provider's error text; the unit suite cannot see a provider rejecting the request, and production
had been failing every call with "OpenRouter 400: Provider returned error" while `pnpm test` was
green. The file lives under `packages/narrator/src/live/`, is excluded from `pnpm test`, runs
through the root `vitest.live.config.ts`, reads the key from `OPENROUTER_API_KEY` or
`packages/narrator/.env.local`, and is skipped without one. Run it before deploying prompt,
schema or transport changes. Owner: "a suite of LLM tests to use not all the time, but for these
kinds of situations."

**D45. The plan schema no longer embeds the vocabulary.** Strict structured output compiles the
schema into a grammar; per-game enums for ports, items, machines, faults and stores pushed it
past the provider's limit ("compiled grammar is too large", every call failing since the
beat-card field was added). Those fields are plain strings validated by the translator against
the snapshot, with drop reasons the model sees; the capabilities block is the model's list of
valid ids. Removing the enums alone was not enough: a live probe showed the nullable strings
(issuerOrg, speaker, beatOfThread, coursePort, cast portId) were what pushed the grammar over,
since every nullable field is a union type and unions compile at exponential cost (Anthropic's
documented limit is 16 union parameters per request, with a stricter internal grammar-size cap).
Those fields are now plain strings where empty means none; only `card` (null when not a policy
decision) and the four-way intents union remain. A new schema compiles on first use (tens of
seconds, longer than the 25 s call budget, so the first call after a schema change can fall back
once) and is then cached by the provider for 24 hours from last use. Prompt v0.9.

**D46. The narrator runs the pace.** Owner, after ten maintenance events in a row at a port where
the narrator had offered no work: pacing is a prompt rule, not a state machine. The system prompt
gains a "Pacing" block: the narrator judges from "What the captain has seen" (with ticks) and the
ship's state whether the story needs forward motion (work, a thread beat, a consequence of an
earlier choice), a breath, or nothing; an idle docked captain gets work first; faults are
pressure, never filler, and never twice in a row. `quietTooLong` now asks for that judgement in
order (offer work if idle at a port, advance a due thread, a minor crew card, a fault only if the
story needs pressure, nothing) and for the choice in rationale. The server logs dropped intents
(`[narrator] dropped`, kinds and reasons) so a plan the translator rejected is visible outside
the call log. Prompt v0.10. Owner: "first there's an opportunity for work, then we pause, one or
two small things happen, then we come back and move the story forward. The narrator ought to be
able to govern that on its own."
*Amended the same day (prompt v0.11):* the first cut also made `jobBoard` re-ask on a timer
(`commerce.reofferSeconds`) and had `quietTooLong` run through an ordered list that began with
"offer work". The owner withdrew both: "I don't want the narrator to think we are asking it
specifically to solve that problem." `jobBoard` asks once per docking (`narrator.jobBoardLastAsk`
keeps the port and tick of that docking's ask and is cleared on leaving the dock); the quiet hook
is a neutral periodic check-in that lists what is available and asks for a judgement; pacing is
the narrator's judgement, not a timer's. The Pacing block in the system prompt stands.

**D47. Parts market.** Owner, after a playtest in which the engine sat at zero integrity with an
unrepairable fault (the repair step consumes `item.spare_parts_stack` and none was aboard) while
the narrator narrated "the part came in and it's fixed" with no lever to make it true. Ports
carry a market (`PortDef.market`: item, count, per-unit price in content; the live stock and price
in `state.markets[portId]`, seeded at world creation and lazily from content for older saves;
schema 3). A repair whose remaining steps consume a part the ship does not have aboard raises
`partsNeeded {machineId, itemDefId, count}` (equipment, once per machine and item, revised
against truth every tick). While docked at a port whose market has the item and the ship can pay,
commerce derives a `buyParts` task: any crew member walks to a cargo transfer tile, spends
`commerce.market.buySeconds` at the counter, and the `buy` step commits the purchase: the ship's
money drops by the price (a `purchase` transaction, visible in the top bar and the ticker:
"Bought spare parts at Crossroads Hub (120 cr)"), the market count drops, the units land on the
deck at the ramp and every crew member is told where they are, `partsBought` (narrative) is
emitted, and the repair resumes. Not a captain decision. If the market lacks the item or money
is short the problem stays open and the digest says why ("not available here", "cannot
afford"). A departure held for repairs (D36) now waits *docked* with the course kept, ramps open,
so the crew can reach the market; the digest's hold line names the missing part and the reason,
for a "leave anyway" card. The narrator gets a fifth lever, `stockMarket {port, item, count 0-4,
priceTier cheap|fair|dear}` (owner-approved vocabulary change, D6/D11; `config.commerce.market`
holds the tier multipliers, the per-command cap and a default price for an item no port lists),
to make a part available, scarce or absent at this or another port; it never buys, delivers,
repairs or pays, and must never narrate a repair, purchase or delivery the digest does not show:
a card may state what someone intends or claims, never that it happened. No scheduled
deliveries. Owner: "let's just deal with things that are already there." Prompt v0.11.

## 2026-10-02 — Passengers and the galaxy

Rulings on `docs/design/passengers-and-galaxy.md` §8. The owner asked for the galaxy expansion
and passenger jobs "per the spec"; each ruling below takes the spec's recommendation, and the
spec's rationale stands as the reason.

**D48. Six ports: a core triangle and three far spurs.** The three existing ports keep their
legs (Hub–Kessler 25, Hub–Meridian 45, Kessler–Meridian 70). Three far ports hang off them on
long legs: Ossory Station off Kessler Drift (120), Vesper Gate off Green Meridian (120), Tern's
Rest off Crossroads Hub (90). Longest shortest path is three hops. Names are placeholders. Every
port now has `character` (two or three sentences the narrator sees) and `castSeed` (two or three
named locals, shown to the narrator at that port without consuming its cast cap), a `lounge`
store (passengers ashore wait there), and a market that differs from the others (D47). Routes
are listed on both ends with equal distance; the loader checks it. Nine ports were rejected as
more content and continuity for no new kind of story.

**D49. Voyages: the sim picks the next hop.** A course or job may name any reachable port.
`travel.voyageDestinationId` holds the far end; `plannedDestinationId` is the next hop on the
shortest path by distance (`shortestPath` in `systems/travel/graph.ts`). Intermediate stops are
real dockings (fee, ramps, market, `approachingPort`); the ship continues on its own once nothing
holds it: no cargo work, no `buyParts` it could run here, no hold for repairs, no pending card.
`jobBoard` is not asked at a waypoint. A card's `setCourse` to a neighbour during a voyage is a
detour: the voyage stays and the sim routes on from wherever the ship docks. The departure gate
(D36) is asked once per voyage: "leave anyway" is remembered with the impairment it answered
(`acceptedImpairmentKey`) and asked again only if that set changes. Freight pay uses path
distance in the price band. Headlines: "Under way to Kessler Drift, bound for Ossory Station";
"Stopping at Kessler Drift on the way to Ossory Station". The first draft's captain-chooses-
every-leg was rejected because it costs a narrator call and a card per waypoint (D14: the captain
acts only through cards).

**D50. A passage is a job with a person in it.** No `Passage` entity: `Job.passage` (`actorId`,
`roundTrip`, `leg` out/ashore/back, `returnsAtTick`, `ashoreSinceTick`, `endReason`
completed/leftBehind/putOff) and two booleans on `offerJob`, `passenger` and `roundTrip`
(`roundTrip` without `passenger` is rejected). The issuer is the passenger; `description` is their
stated purpose, the truth may differ in the narrator's notes. Luggage is the job's cargo line,
zero or one line of one unit, hauled and held like freight (the GDD §7 diamond rule with no new
code). Two shapes only: one-way and there-and-back. One passage at a time, and it is the job
(D16): a passenger competes with freight for the ship. Accepting spawns the passenger from the
generic `crew.passenger` template with the issuer's name at the personnel ramp; they keep
`crew: true` so needs, movement, bunks, galley, ambient conversation and perception all work,
and `passenger: true` keeps them out of task and post candidates, bridge staffing and the
market. No cabins. On a round trip they go ashore at the far port (`availability: offShip`, held
in the port's lounge store), the voyage home is planned at once and departure waits for them
("Waiting for <name>"); they return at a tick drawn from `commerce.passage.ashoreSecondsMin..Max`
(60 to 180) on the commerce RNG stream. If they are not back `commerce.passage.overdueSeconds`
(120) after going ashore, the kernel queues one policy decision (`commerce.passengerOverdue`,
brought by the first officer, narrated through `policyDecision` per D37): "Wait for them" /
"Leave without them". The name table has no pronouns, so cards say "them". Leaving ends the
passage `leftBehind` with no fare and the passenger stays at that port as an off-ship actor, the
narrator's to use as cast. `endPassage { jobId }` is the second failure mode: a card-side effect
(`decisionSide.effect`: none | setCourse | endPassage) that puts the passenger off at the next
docking (now, if docked), `putOff`, no fare. One fare, paid on completion, from the `passenger`
price band (6 to 12 credits per unit of path distance, doubled for a round trip; luggage adds
nothing; four docking fees on a round trip through a waypoint are real costs the band clears:
Hub to Ossory and back is 1740 to 3480 against 600 in fees. A short hop is deliberately thin:
Hub to Kessler one-way is 150 to 300 against one fee of 150, so passengers pay when they go far).
Events `passengerBoarded`, `passengerAshore`, `passengerReturned`, `passageEnded {reason}`;
only `passengerReturned` joins the default `hookOnEvents` (boarding follows the offer card by
seconds and arrival already hooks). The narrator never decides a passenger's fate and never
narrates what they did ashore as fact; the null narrator never offers passages. Luggage on a
round trip is unloaded at the far port and does not come back (v2 will decide whether it should).
Opinion of a passenger lives in threads (D32), not a per-crew table. Deferred to v2: undisclosed
destinations, luggage that goes ashore, passenger illness, mood effects on crew.

**D51. The narrator budget, measured.** `crew pacing` (apps/cli) runs a headless hub → Kessler →
Ossory → Kessler → hub round trip against a stub narrator with 25 s latency and the host's
run-ahead model, and reports calls per hook kind, sim time, stall and wall time per speed. The
first run, at `quietTooLongSeconds` 40, cost 13 calls (15 with freight), not the spec's eight:
three quiet check-ins per far leg, one landing 10 s after an approach hook and one in the same
tick as one, because hooks did not reset the quiet timer. Two changes: `quietTooLongSeconds` 40
→ 60 (spec §8.6), and the quiet timer now counts from the last narrator contact of any kind (a
narrative event or any hook raised), runs last in the tick and yields to any other hook, so a
tick raises at most one hook and a quiet check-in only follows a real silence. Result: 10 calls
per round trip (4 approach, 2 job board, 3 to 4 quiet, 0 to 1 notable), no stall at 1x, about
55 s at 2x, about 3 min at 8x where the narrator is the clock. Each far leg still gets two quiet
check-ins; one would need `quietTooLongSeconds` near 75 or a timer that defers when an approach
is imminent, left for the playtest. `CREW_NARRATOR_MAX_CALLS_PER_HOUR` default 6 → 30 (one trip
is a third of it; back-to-back trips at any speed would exceed it, which is the cap's job).
Startup still costs one full latency at tick 1 (the first `jobBoard`), shown as a loading
screen, not stall.

**D52. One job at a time, enforced.** D16 was prose until passengers made it bite. The kernel's
`acceptContract` now rejects while a job is in hand (accepted, under way, or delivered and not
yet paid), except a job being finished at this very port (freight unloading at its destination,
a passenger walking off at their last port), since an offer carded on the first docked tick
would otherwise deadlock behind its own card. The translator drops `offerJob` for the same
reason, hooks ask for one offer and none while a job is in hand or at a waypoint, and a
passenger offer whose card slot is already taken is dropped with that reason rather than posted
quietly (a quiet offer never reaches the captain; there is no board). `setCourse` cannot replace
a live passage's far destination; neighbours remain detours. Putting a passenger off cancels
the voyage (and the course when docked) and unloads their luggage where they leave; leaving one
behind keeps the voyage home. The voyage home is planned on arrival, before the passenger walks
off, so `jobBoard` never fires in that gap. A due return waits while the overdue card is still
unanswered, since no decision can be withdrawn. A passenger who is left behind or put off drops
off the roster and the digest's Aboard line and appears in the narrator's people section at
that port; the server places their cast entry there from state. Prompt v0.14.

## 2026-10-03 — The plan schema leaves the grammar

**D53. The plan schema rides in the prompt, not in a grammar.** The passenger booleans on
`offerJob` pushed the strict-output schema past the provider's grammar cap again ("compiled
grammar is too large" on every call; the third time after D45 and D47). A direct probe showed the
schema at 6098 bytes failing and any one of several 400-byte cuts compiling, so the plan sat on
the cap and every new lever would have cost a schema redesign. OpenRouter sends a `json_schema`
response format to Anthropic as a grammar even with `strict: false`, so the transport now sends
no `response_format` at all: the JSON schema is the last system block (`schemaInstruction` in
`openrouter.ts`; game-independent, so it stays in the cached prefix) and `runNarrator`'s zod
validation, which already ran on every reply, is the only check; a reply that fails it falls back
`schemaInvalid` and the client retries (D43). Sonnet 4.6 returned a valid plan in 11 of 11 calls
(3 probes, 8 live tests) and GPT-6 Luna in 14 of 14, prompt caching intact on both. This also ends
the first-call fallback while a new grammar compiled (D45). The schema-size test stays, as a
prompt-token budget (8 KiB, was 6) and to keep per-game ids out of the cached prefix. Tool use
with one tool per intent was the owner's general preference and is the likely next shape; not
worth the rewrite now.

## 2026-10-03 — The log keeps time, and arcs end on a card

**D54. The narrator ends its own arcs, on an ordinary card.** Threads used to leave the notes
silently, so the captain never learned a story was over. Prompt v0.15: when a thread is over (its
payoff landed, the job it rode on is done, or events made it moot), the narrator puts one closing
card in front of the captain that makes plain the story is finished and how it came out. This is
a normal `surfaceDecision`, usually with two effect-none sides for how the captain takes it.
Only after it shows under "What the captain has seen" does the thread leave the notes. The
`notableEvent` hook names `contractCompleted` and `passageEnded` (both already hook) as the
moment for a job's closing card, or the next call if a card is already waiting. A separate
"job done" or "story's end" card type was tried and rejected: there is one kind of card, and the
narrator is responsible for its own arcs.

**D55. One ship's log, in playback time.** The ticker was fed when the worker produced a frame,
so with run-ahead (D14) it told the viewer about things the deck had not shown yet. It is now
the ship's log (`apps/web/src/ui/log.ts`): every entry is stamped with its sim tick, kept in tick
order (200 entries), and shown only once playback reaches that tick. Event lines and the cards
the captain was shown form one feed, newest on top, scrolling in both orientations. A card is
logged at the tick it was raised and shows "waiting" until answered; tapping it then brings the
card back up. Once answered it shows the choice, and expands to the full text and aftermath. The
log is not saved and starts empty after a reload, as the ticker did.

**D56. A closing card names its thread, and the server retires it.** Under D54 a closing card
was not tied to any thread, and the thread stayed in the notes until the model saw the card
under "What the captain has seen" and dropped it itself. A model that kept the thread a call
too long saw an open story and closed it again (a playtest showed "Manifest Closed" and then
"Fenwick's Handoff" for one job). `surfaceDecision` gains `closesThread` beside `beatOfThread`
(D39): empty, or the exact title of a stored thread; one written only by this call's notes
does not count, and a card cannot both foreshadow and close. When the card goes up the
server retires the thread whatever the model wrote, records the title on the card's history
entry (`CardShown.closedThread`; the digest marks it `(closed thread "...")`), and keeps
retiring any thread whose closing card is still in that history, so a second closing card
finds nothing to close and is dropped with a reason. The title goes on the card's prompt params
as `closesThread`, and the ship's log marks the card "✓ Story closed: <title>". Thread titles
are private notes, so a title that fails the player-text checks closes as plain "Story closed".
Still one kind of card, as D54 decided: this is a label on a card, not a card type. Prompt v0.16.

## 2026-10-03 — Dockside

**D57. Ports get a place, arrival gets a stage, and the captain goes looking for work.** Design in
`docs/design/dockside.md`, plan in `docs/design/dockside-plan.md`. Owner rulings: one authored
dock map per port; the captain walks ashore to look for work and that walk triggers narration
(replacing `jobBoard`); the narration that decides who is on the dock when the ship lands sets the
stage only (no card, no arc or note changes, but aware of the story); stars stream past in transit.
Delegated calls taken in the design (§8 there): the ship never moves on screen and port-bound
scenery is a pure function of travel stage and progress; both ramps on the south flank; Green
Meridian becomes a planet beside Tern's Rest; offered freight is physically staged; locals are
scripted presences; the staging hook is guaranteed and gates arrival, and its failure falls back
to the sim's floor set instead of pausing the game (an exception to D43); cards are delivered
where the captain meets the speaker, superseding D42's wait-for-dock. Each phase records its own
entries as it lands.

**D58. Phase 1 of Dockside: the world moves past the ship.** The render frame's travel names both
ports at every stage (the dock's port at both ends while docked, so neither id is ever optional)
and `drifting` (false docked). `RenderDoor` also gains `openFraction`, beyond the plan's three
fields, so a ramp is drawn by how far it really is open rather than by a client-side guess; a
jammed door reads shut. Powered ramps travel open and shut in `doors.rampOpenSeconds` (2 s), and
the schematic estimate uses it; hand-opening is unchanged. `PortDef.setting` is `station` or
`planet`: Tern's Rest and Green Meridian, rewritten as a farming world with a small spaceport.
`sceneAt` (`apps/web/src/render/scene.ts`) is pure in stage, progress, the ports and
reduced motion; beside the planned channels it carries `altitude` (the planet's ground scales
with it), `portAlpha` (the reduced-motion cross-fade), `cloudScroll` and `dust`. The berth offset
is in deck lengths and only ever increases from approach to departure. Stars scroll at real time
times `starSpeed` and stop when paused, not faster at 8x. The canvas runs its own animation loop
and redraws only while stars or plume move or something changed; playback interpolates travel
progress within one stage so the berth slides smoothly between 10 Hz frames. The foreground is
drawn under the dots and labels, so walls and clouds never hide a person. In flight the camera
frames the whole hull plus a tile; on a portrait phone the deck is about 15% smaller than
before. No offscreen caching: a frame measured under 1 ms on desktop; revisit after the phone
playtest. Ramps had been closing themselves 3 s after docking like any powered door; D59 stops
that, so docked ramps stay down.

**D59. The dock is grafted onto the deck's grid, not joined by portals.** The phase 2 spike
(`docs/design/dockside-spike.md`) reverses the design's recommendation (dockside §3.4). While a
dock is alongside (`state.deck.dock`, set by `attachDock` at the start of `docking` and cleared
by `detachDock` at the end of `undocking`), its floor is stamped into the ship deck's nav grid
in the deck's own frame: one grid, one coordinate frame, one `deckId`. A person on the dock is
an ordinary `onDeck` location whose tile is dock floor, possibly at negative coordinates. Dock
floor is in no compartment and the hull walls it off except at the ramp doors. Portals would
have kept a separate area per dock, and every bare `TileCoord` outside `systems/spatial`
(routes, tasks, claims, plan steps, `AgentView`, the planner's estimates) would then need an area
tag, a change the compiler cannot find for us; portals in a shared frame avoid that but add a
second grid for no gain. Grafting costs a grid origin and a rebuild on attach/detach inside
`systems/spatial`, and one cost outside it: `onDeck` no longer means aboard, so "aboard" checks
use `isOnDock`. Ramps are now owned by travel alone: they no longer auto-close (until now they
closed 3 s after docking), actors never request them, and planning treats a ramp as passable
only while it is fully open and travel still wants it open, from truth, since everyone knows
whether the ramps are down. `detachDock` refuses while a ramp is down or anyone or anything is on
the dock, so departure must bring everyone aboard, and keep the ramps down until it has, before
raising them. Dock layouts carry no ramp landings; each ramp lands on the dock tile across its
hull edge. A multi-deck ship would still want portals between decks; this does not preclude
them. Departure prep runs its 5 s clock while the ramps retract and only waits on them if it would
otherwise end with one still down, since they used to be shut long before prep began.

**D60. A dock map is authored content the sim reads directly.** `DockDef` (one per port,
`packages/content/data/docks/`) replaces the spike's `DockLayout`: there is no separate nav
layout and no conversion step. Walkable means a `floor` legend tile under no blocking prop. Areas,
props and foreground are rects; props and foreground use closed kind vocabularies so the renderer
knows what it must draw. Content validates the geometry as plain grid checks (berth tiles are
exactly the ship's floor at `shipAt`, ramps land on walkable floor outside any area, every post
and area is reachable from every landing, one gate, warehouse door, staging area and delivery bay,
at most one stall, a 48×36 cap); because content may only import types from sim, the walkable
rule is written twice, so `crew content validate` also grafts each dock with the sim's own
builder and a test keeps the two masks identical. `castSeed[].post` names a post on the port's
dock; every port has at least one posted regular. The personnel ramp moved to the airlock's south
wall at (2,17), so both ramps face the quay. Kessler Drift has no stall (its market is through the
gate); Vesper Gate's chapel doors are its gate.

**D61. The dock exists in the sim from docking to undocking, and nobody is left on it.** Phase 2,
part A (spike build order 4–5 and the save migration). Travel grafts the port's dock at the start
of `docking` and casts it off at the end of `undocking`; a new game starts with its port's dock
alongside and the ramps already down; a port with no dock map keeps the transfer tiles. A travel
invariant (`travelViolations`) holds the dock to exactly that window. Departure prep keeps the
ramps down while anyone is on the dock or walking onto it, and while freight is still being
loaded with a dock alongside (part B's staging needs it), and its clock does not run while anyone
is out: it calls them aboard with `comeAboard`, a personal activity the planner never chooses, a
walk at essential-operation urgency to the top of the nearest ramp. The headline reads "Waiting
for <name> to come aboard", and "raising the ramps" if prep's clock has run out with a ramp still
moving. The waiting happens in prep, not at the docked → prep gate. A departure is never held
forever, and never silently: someone on the dock who cannot walk (not available, not crew, or
whose walk failed) is brought up the ramp by the dock crew at once, and everyone still out is once
the call has run `travel.recallAboardSeconds` (60 s); both emit `broughtAboard`, which the ticker
shows. A passenger walking off is never called back. Anything still lying on the dock when it
goes is left at the port's warehouse (`leftOnDock`), and anyone still on it is brought aboard as a
last guard before `detachDock`'s own checks. The "aboard" sweep, site by site: the render frame
draws the dock and everything on it (`RenderFrame.dock`, `onDock` on actors and on-deck items);
loading counts freight on the dock as not aboard, and so does a put-off passenger's luggage; a
passenger standing on the dock is still the ship's to walk off; a part on the dock counts towards
`partsNeeded`, since it is within reach while docked; the roster, `AgentView`, needs and ambient
chat are unchanged. Someone on the dock looks around the dock (items and people; dock floor is in
no compartment), walks are labelled "going ashore", "walking on the dock" and "coming aboard",
movement emits `wentAshore` and `cameAboard` (trace) when a step crosses a ramp, and the narrator
digest says "on the dock". `DockDef.setting` is dropped: a dock is a station or a planet because
its port is, and the sky colour is checked against the port. Save schema 4: migrations now
receive the content they restore against, and 3 → 4 sets `deck.dock` for a save docked, docking,
preparing to depart or undocking at a port with a dock map, asking a docked save's ramps down;
freight in a port store stays where it is. Restore now also fills config keys a save predates from
the loaded content, with a warning, because a save from before D58 had no
`doors.rampOpenSeconds` and its ramps would never have finished moving.

**D62. Phase 2 of Dockside, renderer: the dock map is drawn alongside, and the camera zooms to
it.** The renderer draws the dock the frame names (`RenderFrame.dock`, D61) from the start of
`docking` to the end of `undocking`, and on either side of that window, when nothing is alongside
but the port is still in view (`approaching`, `departing`), the dock content holds for that port
(`dockInView`, `apps/web/src/render/dock.ts`). It sits at `−shipAt` plus the scene's berth offset,
so it slides in during `docking` and away during `undocking` and `departing` as the phase 1 berth
did; a port without a map keeps the stand-in. People and loose items with `onDock` set are drawn
moved by the same slide and nobody aboard is, which is safe because no one crosses a ramp while
the dock slides. The look is derived from the map and its port's setting, not authored: stations
get deck plates and a dark bay pit that fills the view as the camera settles; a planet berth
surrounded by quay is a pad among fields hazed in the dock's sky colour; an open planet berth is
a pier of planks over a sea of cloud. Station quays get a clamp near each end of the ship that
engages over the last fifth of `docking` and releases over the first fifth of `undocking`.
Structural foreground (bay walls, terminal edge, rock) stands only on non-floor tiles, so posts
in wall gaps show; the doors at gates and warehouse doors are drawn above it, and no foreground
piece is more than 0.3 opaque over the ship. The camera interpolates each edge from hull plus a
tile to hull plus map plus a quarter tile by `cameraT`, under reduced motion too, where only the
slide becomes a fade; on a 390×700 phone the docked scale is 12.8–14.4 px a tile, so machine
labels hide while docked and compartment labels stay, and actor labels are kept on screen.
Tapping a post or bare dock floor opens a place card from content (no snapshot); the item
inspector describes an item on the dock (`isOnDock` on the snapshot) by its area or nearest post,
and no longer indexes the deck's tiles with an off-ship coordinate.

**D63. Port work is physical on the dock.** Phase 2, part B (plan items 7, 8, 9 and 11; design
§4). At a port with a dock map, freight, purchases and passengers move across the dock on foot;
a port without one (hand-built tests) keeps the stores and transfer tiles.
*Offers.* An offer's crates (one per unit, in `Job.cargoItemIds`) are set out on the origin
dock's staging area while that dock is alongside and the offer can still be taken there
(`docking` or `docked`): at `offerJob` when docked there, else by commerce's sweep on the tick
the dock comes alongside, so an offer made in flight slides in with its crates. "Owned by
nobody" is the job still being `offered`: no `cargoToLoad` exists, so no task, no crew member
touches them, equipment does not count them as parts aboard, and the render frame marks them
`offered`. Declined, expired, or still open when departure prep begins, they are withdrawn
(deleted, `freightWithdrawn`) until phase 3's dock hands cart them in. `commerceViolations` (new,
for tests) holds the rule. Accepting raises the load work for the crates already there and tells
the crew where they lie.
*Loading* is an ordinary on-deck pickup down the cargo ramp, one crate per trip. The hand truck
is an item def with a `handTruck` tool kind that no scenario places and no code reads; several
crates per trip needs one activity holding several tasks' claims, so it is deferred. Measured
cost: `crew pacing`'s freight round trip (Hub → Ossory → Hub) runs 568 sim-s instead of 491, and
11 narrator calls instead of 10 (one more quiet check-in); the full-sim crew's-day case now runs
seven sim-minutes, since the pilot holds the helm through a longer second port call.
*Delivery.* With the destination's dock alongside, `cargoToUnload` derives a haul to the delivery
bay (completion `itemInDockArea`, each crate aiming at its own bay tile first);
`deliveryComplete` accepts the bay or the store. Once all of a job's unload work at the port is
done, commerce pays (`contractCompleted` and payment unchanged, once) and then carts the crates
from the bay into the warehouse store (`cargoTransferred`); a put-off passenger's luggage too.
*Parts* (D47): `marketCounter` sends the buyer to the stall's counter (the floor tile the post
faces, which keeps the post tile for its local), where the units go into their hands, and they
carry them up to the top of the cargo ramp (`stowBought`). With no stall (Kessler Drift) the
buyer walks to the gate and steps through (`throughGate`: off ship, in the port's market store,
for `buySeconds`), comes back to the gate with the units and carries them aboard the same way.
A claimed `buyParts` task outlives its resolved `partsNeeded` until the units are set down, as a
claimed `staffStation` does. Travel counts a buyer out through the gate as ashore; an overdue
call, or the dock's last-guard clear, ends the errand at the gate. Stock and prices unchanged.
*Passengers* appear at the gate when booked or back from ashore and walk aboard (a `comeAboard`
walk to the passenger spawn point, handed out every tick like the departure call); walking off,
they go out through the gate. A walk across a ramp still lowering waits instead of stepping off
at once. `passengerBoarded` still fires at booking.
*Departure.* Cargo work also covers freight of a job taken at this port that still lies on the
dock, whatever its work says: it holds a docked departure and keeps prep's ramps down, and the
call aboard still starts only once loading is done.
*Narrator.* While a dock is alongside the digest has an "On the dock (<name>)" section: the map's
ambience line and the freight on it by job (on offer, waiting to be loaded, delivered to the bay,
unloading). Prompt text unchanged; `pnpm test:live` 8 of 8.
*Save.* Folded into 3 → 4, since production is still on schema 3: a save docked or preparing to
depart has a taken job's freight waiting in that port's store moved onto the staging area, with
the crew's beliefs moved too, and its open unloads there revised so they re-derive to the bay.
*Speed.* Planner travel estimates now go through the nav path cache under the schematic key
(ramp changes and geometry rebuilds already clear it); the dock's long walks had made uncached
A* the planner's main cost. The three full-sim cases take 13.3 s against 14.8 s before.

**D64. Phase 2 verified end to end; what the playthrough turned up.** A browser playthrough
(null narrator, 8x, landscape and 390×700) and headless tours of all six ports, every invariant
checked each tick. Fixes, each with a test:
*Offered freight* is drawn as a translucent crate with a dashed outline in its class colour,
never piled with taken freight of the same kind, and the item inspector says "freight on offer"
and that nobody loads it until the job is taken. The host now snapshots the tick a hook or
decision halts on, so tapping a crate while its offer's card waits ("Inspect ship") finds it;
the ring's last due snapshot predated the crates and the tap showed nothing.
*Carting.* Delivered crates are carted from the bay whenever a dock is alongside, not only while
`docked`: the last crate set down usually ends the port call, travel moved to departure prep
that same tick before commerce ran, and every delivery was left to `leftOnDock` at undocking.
*Work.* An actor plans a new task or activity against truth before giving up the current one:
a repair whose part is aboard nowhere (Green Meridian and Vesper Gate sell none) was chosen from
beliefs every time its blockage expired, made the crate carrier set the crate down mid-dock and
then failed, holding one Vesper delivery 145 s. An actor giving up a task sets down the tools and
consumables they had picked up for it, so the ship's only spares are not left in a pilot's hands.
D63's freight brief skips crew who have not had their first look yet, since a single fact
stopped the ship-familiarity brief and they never learned where the stores were.
*Narrator.* The translator drops `offerJob` by the kernel's own rule (`jobBlockingAcceptance`)
rather than a stricter copy, so an offer made while freight is unloading at its destination, or
on approach, goes through; the null narrator never offered a second job before (every docking
after the first sat idle on `quietTooLong`). The kernel's rule itself had let freight under way
slip (it filtered on `jobInHand`, which counts only passages once they leave), so a second job
could be taken mid-voyage; it now blocks until the ship docks at the freight's destination, as
D52 says.
*Phone.* Rotation is decided by the window, not the canvas: at 390×700 the canvas is nearly
square and the drawing flipped 90° whenever the headline wrapped to two lines.
Not changed: docking often waits 10–20 s "for someone at the helm" because the pilot wanders off
in transit; a ship out of spares far from a market drifts until the narrator acts.

**D65. The hand truck: several crates per trip, one activity holding several claims.** Dockside
§4 ("several per trip"); D63 had deferred it. *Content.* `ItemDef.capacityUnits` (Zod: positive
integer) is how many units of freight a hand truck carries; validation requires it, at least 2,
on every `handTruck` tool (which must be unique) and allows it nowhere else. The hand truck
carries 4, and the default scenario stows one on the cargo stowage zone's first tile (8,12), in
the hold.
*Planning.* The planner is unchanged: it picks one haul as before, through the `AgentView`. When
work starts that haul (`startTask`), `systems/work/truck.ts` plans it as a trip if the actor
believes a free truck lies on deck (free: no activity names it, the same public bookkeeping as
claims) and knows of more open, unclaimed, unblocked hauls the same way (load with load, unload
with unload, to the same zone or dock area) whose crates they believe lie on deck, up to the
truck's capacity, nearest first. A haul with nothing to add (or none of this) is one crate in the
hands, as before; freight in a port store (a port with no dock map) never goes on the truck.
*One activity, several claims.* The planner's task stays the activity's own (`taskId`, the lead);
the others are `Activity.haul = { truckId, legs: [{ taskId, claimId }] }`, an optional field
present only on a trip. Every held claim is renewed each tick, expires like any other (ending
the trip), shows its owner to other planners and keeps its task from being pruned. Steps: fetch
the truck (`pickUp`), `loadTruck` each crate within reach (it goes `inContainer` the truck),
`unloadTruck` each at its own destination tile (hold zone when loading, its bay tile when
unloading), and `parkTruck`: where the last crate went if that is aboard, else at the top of the
cargo ramp. A leg settles the moment its crate is set down (completed if its custody predicate
holds, else released); the lead's crate goes down last and the lead settles when the plan ends,
after the truck is parked. So the cargo work, and with it departure (`hasOpenCargoWork`), waits
for the truck to come back aboard; D61's call aboard never starts on a pusher mid-trip, since it
only starts once loading is done.
*Stopping early.* Interrupted (a need or emergency the selector lets through, `bringAboard`),
failed, or incapacitated, the pusher sets the truck and every crate
on it down where they stand and knows where they are; every held task whose crate already made
it is completed, the rest released. Nothing rides on a truck nobody is pushing
(`workViolations` checks it, with one trip per truck and only its pusher holding it). The crates
are ordinary on-deck freight again, picked up by hand or by the next trip, which fetches the
truck from wherever its pusher believes it is, the dock included. A truck that is not where the
actor believed turns the trip into a hand haul of the lead (legs released, nothing blocked); a
leg's crate that is not where they believed drops that leg (backed off, released) and the trip
goes on. A truck still lying on the dock when it goes (abandoned with no haul left to fetch it)
is handed up the cargo ramp by the dock crew (`gearBroughtAboard`, notable), not left at the
warehouse like other things on the dock (`leftOnDock`, unchanged for everything else).
*Render.* No projection change: the frame already carries the truck as `carried` and the crates
on it as `container` items. The canvas draws a pushed truck with crates as a handle and toe plate
with up to four crates stacked on it and a count tag (`drawCarriedItems`); the item inspector says
"on the hand truck, pushed by <name>". The headline no longer counts a crate on a pushed truck as
stowed. Labels: "fetching the hand truck", "loading <crate>", "hauling <n> crates", "unloading
<crate>", "returning the hand truck", "parking the hand truck".
*Save.* No schema bump: `Activity.haul` and the three steps are additive plain data, and a save
mid-trip restores and finishes it identically. Folded into 3 → 4 (production is still on 3): a
save with no hand truck gets the content's one on the stowage zone's first tile, its id from the
save's item counter; `MigrationContext.content` now includes `items`.
*Measured* (seed 20260930, real content, stand-in narrator). The full-sim port call at Green
Meridian (unload six, load six) runs docked → preparing 91.7 s against 190.4 s by hand, and the
opening Hub call (load six) start → preparing 63.8 s against 90.8 s. A six-crate Hub → Green
Meridian job alone:
loading 56.2 s against 90.5 s, unloading 48.6 s against 100.7 s. `crew pacing` freight round
trip (two crates): 508.9 sim-s against 567.8, 10 narrator calls against 11 (the plain trip is
unchanged at 434.8). The full-sim crew's-day case now runs eight sim-minutes: with the shorter
call the ship is at a third port by seven and the pilot back at the helm before anything else
came up; it allows one more offer card (four decisions). Its prep-time case no longer counts
time someone is on the dock during prep (D61's call aboard, the last hauler walking back from
the bay), which is not the pilot's walk it guards. With D64 on top (fresh crew briefed, so they
know the truck from the start): `crew pacing` freight 494.7 sim-s, plain 430.0. One deckhand
now takes the opening six-crate load in two trips (4 + 2) while the rest of the crew eat and
chat, so the full-sim multi-crate case asserts what the truck should do rather than "two or
more haulers": no single claim set beyond the truck's capacity, never the whole stack at once,
the rest open to anyone free. The Hub → Kessler integration case reads "set down in the bay" off
crate positions, since the trip's lead haul only completes once the truck is parked, and counts
a crate on a truck pushed across the dock as carried there.
*Found, not changed:* the W4a "ship familiarity" brief only runs for an actor whose knowledge is
empty at their first look, and D63's `briefCrew` writes freight facts at acceptance, which can
come first (the opening offer is taken at tick 1–2); such a crew member never learns where the
ship's stores are, the truck included, until they walk past them. In the full sim the pilot
never knows where the rations are.

**D66. Phase 3 of Dockside, sim side: locals, the floor set, dock hands and the guaranteed
staging call.** Plan items 1–5 and 8–10 (design §5, §6.1; contract for the narrator, server and
renderer work in `docs/design/dockside-phase3-contract.md`).
*Locals are their own table, not actors.* `state.dockside.locals` (ids `o<n>`): name, role, a
palette seed from the name, an optional new face's look line, an origin (regular, receiver,
left-behind passenger, staged, dock hand), a post, a label, a position on the dock floor and one
scripted behaviour (`atPost` with a shuffle every `travel.localShuffleSeconds`, `walkTo`,
`leave`). An `Actor` flag was rejected: some twenty loops over `actors` (needs, planner,
perception, staffing, the call aboard, the dock's last guard, door occupants, ambient chat,
roster, render) would each need to skip them, and an actor would carry needs, knowledge and
skills that are lies. A separate table is excluded from all of them by construction. Locals walk
the crew's nav grid with the crew's A* under a policy where every door is impassable (the only
doors on the graft are the ramps, so they never set foot aboard), at `movement.walkSpeed`, and
the corridor-passing slowdown counts locals for the crew and crew for locals. The planner sees
nothing of them: the `AgentView` is unchanged, since the planner never treats other people as
obstacles either; "visible only as obstacles" is the movement system's passing rule. Props the
staging call places are presentation records, never items, so nobody can eat or fit them. Travel
invariants: no local, prop or dressing without the dock alongside; every local (and every tile
of its walk) on that dock's floor.
*The dock's people come and go with it.* The dock is dressed when it attaches at the start of
`docking` (and at world creation; a restored save with an undressed dock is dressed on its first
tick, so the 4 → 5 migration places nobody), and at the end of `undocking` the locals and props
go with it without walking (design §4: "slides away with them"), before `clearDock`, which never
sees them. Departure never waits for a local: nothing about them is cargo work or "ashore".
*The floor set* (`core/floor-set.ts`) is pure over state and content, with no rng draw (a dock
hand's name is a hash of the save's seed and the job into the content name table), so the hook
can show the narrator exactly who will be there: posted regulars; a receiver dock hand by the
warehouse door for freight bound here; a passenger left behind or put off here, on the bench. The
issuer of a job finished here is never at the destination (freight is issued at its origin; a
round trip's issuer is the passenger, aboard), so the design's second half of item 2 adds no one.
A passenger due back already appears at the gate as an actor (D63), not as a local.
*Dock hands* (`systems/commerce/dock-hands.ts`) take over D63's appear, vanish and move points:
an offer's crates come out of the warehouse door on a hand's trolley (the job is offered with no
crates until the hand sets them down); a withdrawn offer's crates are walked back in (they stay on
the staging area, still nobody's, until picked up); a delivery's crates are taken in by the
receiver, or a new hand, once every unload is done and the job is paid on the bay. Carried crates
are presentation (`Local.carrying`), never items on a local, so custody stays one location per
item. An errand with no route, or past `travel.dockHandGiveUpSeconds` (30 s), does the instant
D63 behaviour and emits `dockHandGaveUp` (trace); one still open when the dock is cast off is
finished the same way (reason `castOff`). A dock with no warehouse-door post (hand-built test
docks) has no dock hands. Accepting an offer mid-walk stages its crates at once, as before; the
hand's errand is then moot and they go back in. The commerce invariant allows the walk:
no crates while a hand brings them out, crates still on the dock while a hand fetches them back.
Equipment and the frame treat a closed offer's waiting crates as nobody's, like an open offer's.
*The staging call is guaranteed.* `stageDock` (context: port, dock, floor set) is raised in
`transit` once the route left is within `narrator.approachHookLeadSeconds` at nominal speed (a
drift delays it, a short leg raises it on its first tick), at every docking whose port has a dock
map, waypoints included. The record rides on the `transit` and `approaching` stage objects
(`TravelState.staging`, owned by travel) and is spent at `docking`, so it never outlives its
leg, and travel derives "answered" from the hook no longer being pending, so core's
`acknowledgeHook` is unchanged. If another hook is pending at the lead point the record waits as
`due` and travel raises it through `raiseHookIfIdle` the first tick none is; travel runs before
commerce, `notableEvent`, the policy hook and the quiet timer, so it is first in line after the
other's acknowledgement. Transit holds at the end of the route until the call is answered; the
approach needs no engine, so a drift during the hold does not hold the ship further. Raising it
re-arms the quiet timer like any hook.
*The stageDock command* is the kernel half of the staging plan: up to three people (port seed by
name, cast member, or new face with role and look) at posts of that dock with an optional label,
up to three props (catalogue items, 1–4 units, on the staging area or by a post) and one ambience
line, validated whole (posts exist on the dock, text non-blank, no control characters or
template braces, length caps, seeds exist, nobody aboard placed, no name twice, one plan per
call). It is in the narrator vocabulary as staging-only (D57 is the owner's ruling for this
vocabulary change): `validateCommand` refuses it from the narrator outside a pending `stageDock`
hook and refuses every other narrator kind while one is pending (`preconditionFailed`). The
ambience line reaches the ticker as a notable `dockAmbience`, never narrative.
*`approachingPort` is retired, not renamed:* `stageDock` has a different context, authority and
answer, and nothing about offers on approach survives (design §6.3). Offers no longer arrive in
flight from an arrival hook; the null narrator answers `stageDock` with an empty plan and offers
only at `jobBoard`; the narrator fixtures' in-flight base (`approachRequest`) carries a
`quietTooLong` hook now. Prompt v0.17 (the hook's instructions and two "on approach" phrases
removed from the static rules).
*Interim narrator and server* (until the staging prompt lands): `runNarrator` and the route
answer `stageDock` with an empty plan without a model call; the route skips the budget, the call
log, notes and the spacing rule in both directions for it, since a staging answer within 100
ticks of a story call would otherwise be refused (and the floor set used) or make the next story
call "too soon".
*Save schema 5:* `dockside` (empty), `nextId.local`, and a pending `approachingPort` dropped as
answered (its id joins `recentHookIds`); a docked save is dressed on its first tick.
*Tests:* the hook at the lead point, the same-tick hold at the end of the route, `due` behind
another hook, a drift during the hold, save and restore with the call pending and a plan stored;
the command's window, refusals and placement; locals leaving with the dock; dock hands staging,
withdrawing, giving up and being cast off mid-pickup; the floor set and the 4 → 5 migration. The
real-content integration run now checks Hal Petrosyan at the queue kiosk on a new game and on
arriving back at the Hub, Kessler's regulars and receiver on arrival there, the receiver carting
the delivery in, a staging call before each docking and no card on the way in. The full-sim run
checks that every dock came alongside dressed and no dock hand gave up a walk.
*Found, not changed:* `notableEvent` only looks one tick back, so a narrative event in the tick a
`stageDock` is raised loses its hook (true of any hook raised by travel first; now it happens on
every leg).

**D67. Phase 3 of Dockside, narrator and server: the staging call runs.** Plan items 6, 7, 9 and 11
(design §6.1, §6.3; the sim's contract in `docs/design/dockside-phase3-contract.md`).
*Its own call.* `packages/narrator/src/staging/`: a system prompt that only sets the stage (place
up to three people, a port seed, a cast member or a new face with role and look, at a post with
an optional label; up to three catalogue props on the staging area or by a post; one ambience
line; never offers, cards, faults, markets or notes), the item catalogue as the second cached
system block, and its own schema in the D53 style (`rationale` plus `placePerson`, `placeProp`,
`setAmbience` intents, schema in the prompt). The reply is parsed with the intents left raw, so a
story intent in it is dropped with a reason by the staging translator rather than failing the
call; a reply with anything beside `rationale` and `intents` (notes, a card) is `schemaInvalid`.
The translator makes at most one `stageDock`, checks each part against the kernel's rules (posts
of this dock, the port's seeds by name with content's spelling, cast names against the stored
notes, nobody aboard, no name twice, catalogue items, the `STAGING_LIMITS` caps, control
characters and braces) plus `textProblem` (numbers, undiscovered faults), clips labels, looks and
the ambience line to their caps and refuses over-long names and roles, and drops each bad part
alone, so the kernel never refuses a whole plan for one placement. It reads the notes and never
writes them: the response has no `notesUpdate`, and the route would not store one for this kind.
*The digest.* The staging call reads the story's digest, minus the story budget, plus "The dock
you are dressing": the dock's ambience, its posts by key, its areas and the floor set from the
hook. Every call made with a dock alongside, story calls included, gets the fuller "On the dock":
the place, the line the log showed on arrival, each local (name, role, post, label, and why they
are there: a regular, a dock hand and their errand, a passenger the ship left, one of this port's
people, in your cast, or a new face with their look, "not in your cast until you write about
them"), the props by where they stand, then D63's freight. The story prompt gains one rule: those
people are really there and make natural issuers and speakers; a new face is cast only if the
story wants them. Prompt v0.18 (also drops the capability list's "called on approach").
*Server.* `runNarrator` and the route run the call for real. Model: `CREW_STAGING_MODEL`, defaulting
to the story model, so a cheaper model is one env var. The kind is `narrator_calls.hook_kind =
'stageDock'` (`narratorCallKind`), not a new column, so there is no migration. Each kind has its
own hourly budget of `CREW_NARRATOR_MAX_CALLS_PER_HOUR`, staging is never refused by the spacing
rule, and the story rule is measured from the last answered story call, so a staging answer
never makes the next story call too soon. Every staging call (ok, error, budget) is logged with
its basis save, as story calls are.
*Failure (D57's exception to D43).* The retries stay the client's, on D43's schedule: in `error`
mode a staging failure is a 502/503 like a story one, so a transient failure costs nothing.
Where a story call would end on the error panel, `stagingRetryAction` instead acknowledges the
hook with no plan (the floor set) and the host logs `[narrator] staging fallback <reason>`; the
game never pauses for staging. In `null` mode the server answers with the floor set itself and
logs the same line. A staging answer does not clear the host's recent-events buffer, since the
next story call has not seen them.
*Null narrator* stages nothing (unchanged from D66, verified).
*Found and fixed:* the live overdue-passenger case fell back `schemaInvalid` in four of six runs
because the model copied `surfaceDecision`'s `beatOfThread` and `closesThread` onto `card`. Those
two keys are now taken off `card` before validation and the correction is fed back with the drop
reasons; any other stray key still fails. It failed three of three with v0.18 and one of three
without the new "On the dock" rule, so the rule may make it likelier but did not cause it; the fix
is unit-tested, not yet live.
*Live (Sonnet 4.6, the production default):* the staging case passed: 8.7 s, 3570 input and 386
output tokens, two people at real posts (the cast member a due thread names at the canteen hatch,
the seed whose grudge it is at her board, both with labels), two crates on the staging area and
one ambience line, nothing dropped. The other story cases passed but the overdue one above. A
cheaper staging model was not tried: the OpenRouter key hit its weekly limit mid-run.

**D68. Phase 3 of Dockside, renderer and inspector: the dock's own people and props.** Plan item
10 (design §5.1; the frame's shapes in `docs/design/dockside-phase3-contract.md` §6). The canvas
reads only `RenderFrame.locals`, `RenderFrame.dockProps` and the content's dock map; no sim change.
*Look.* A local is a dot the crew's size in one of eight muted mid-light hues picked by
`lookSeed % 8` (`localLook`, `apps/web/src/render/locals.ts`), with a rim of the same hue
darkened: never crew gold, never the passenger's pale fill and blue rim (a test holds every hue
at least 80 RGB units from both). A dock hand carting crates pushes a trolley drawn like the
crew's hand truck (D65), its crates in general freight's colour since the frame carries only a
count. Locals and props are on the dock by construction, so `withDockSlide` moves all of them.
*Props* are drawn as their item would be (`itemColor` by kind and class), muted 40% toward grey,
as that many small crates set out on the tile and never with freight's count tag, so set dressing
does not read as cargo the crew can handle or as an offer (D64's dashed outline).
*Labels.* A local is labelled only while doing something (`label` present), by first name
("Hal — waiting by three crates", up to 34 characters), in a dimmer text colour than the crew's,
and stacked with the crew's labels so the two never overlap. A regular standing at their post
says nothing a tap does not, and the docked phone view (D62) was already crowded; in the
playthrough the only local labels on screen were the dock hand carting and the receiver waiting,
so no zoom threshold was needed. The check also found every multi-crate hand truck's count tag
printed over its pusher's label ("Priya Kessler — ×3 hauling"): the tag now hangs below the toe
plate, and the label of anyone pushing a loaded truck or trolley is lifted clear of its handle.
*Tapping.* `pickAt` (`render/pick.ts`, moved out of `DeckCanvas`) tries people first, crew and
locals together, the nearest within 0.8 tiles; then the ship's items, the staged props, machines,
and last a post or bare dock floor, so a tap on a regular at their post opens the person. A prop
has no id, so it is selected by its index in the frame (props are set once at dressing and gone
with the dock, and a position would change as the dock slides). Both open from the frame and
content without a snapshot, like a post (`ui/dockInspection.ts`): a local shows name, role,
"Where" ("at the queue-board kiosk" within two tiles of their post, else the dock area or nearest
post, with their post on its own line), "Doing" when labelled, and a new face's look line; a
prop shows its name, "on the dock" and "Three of them, in the freight staging area on the dock.
The port's, not the ship's." A local gone from the frame between the draw and the tap opens
nothing. Shared screen-space pieces moved out of `draw.ts` into `screen.ts` (the transform,
`toScreenPx`, dot and carried sizes) and `crates.ts` (crate, badge, truck), re-exported where
callers used them.
*Verified* in the real app (null narrator, landscape 1280×800 and 390×700): Hal at the queue
kiosk and Anneke at the night stall on a new game, a dock hand bringing the opening offer's
crates out on a trolley, the receiver waiting at Kessler's ore-store lock, each tapped.
Playback's interpolation of locals by id (D66) is now tested.
*Found, not changed:* Kessler Drift's ore conveyor is drawn with round yellow rollers that read
like crew dots at phone scale (phase 2 prop art).

**D69. Phase 3 verified end to end; what the playthrough turned up.** Browser playthroughs of
the real app at 8x (landscape 1280×800 and 390×700): the null narrator; a fixture staging model
behind the real route and staging translator (new face, port seed, props, ambience, a story intent
to drop); and a staging model that always times out, in `error` mode. Headless tours of all six
ports (seeds 3, 5, 7, 11, 13; the departure gate answered both ways), every invariant checked each
tick, with fixture plans (new face, seed, a regular moved to another post, props by post and on
the staging area, ambience), empty plans and a plan the kernel refuses (a post not on the dock),
and save and restore mid-hold and mid-carting run side by side with the unrestored world for 600
ticks (identical but once, where a contested interaction position changed hands across the
restore, which W3 accepts). Seen working: the regulars at their posts at every docking, the
receiver waiting by the warehouse door, dock hands carting offers out and withdrawn crates back,
the staging hold one tick when answered in the run-ahead, no card from the staging call, nobody
waiting on a local at departure, the locals gone with the dock, no console errors.
Fixes, each with a test that failed before:
*Kessler's receiver lost the race to the cast-off.* The ore-store lock was 27 steps from the
delivery bay, round the conveyor, and the receiver is only sent once the hand truck is parked,
which is when prep begins: in three of seven Kessler calls the crates were taken in by
`dockHandGaveUp` (`castOff`) as the dock left. The rock at (30, 22) is floor now (the outcrop's
foreground moves onto the walls it stands for), five steps; content's tests hold every dock's
door within eight steps of its bay. No dock hand gave up in any later run.
*The ore conveyor* draws its ore as small angular chunks in dull rock colours (D68's found item):
no discs, nothing within 80 RGB units of crew gold.
*A notable event beside the staging call* (D66's found item): a hookable event committed the tick
before travel raised `stageDock` lost its `notableEvent`. Phase 8 now records
`narrator.pendingNotable` for a hookable event; travel raises the hook from it the first tick no
hook is pending and clears it; a story hook raised after the event clears it too (that call reads
the event), so the call count is unchanged except for staging. Folded into 4 → 5: a narrative
event in a save's last tick becomes the pending one.
*Staging retries froze the ship.* The sim is halted on the call, so D43's schedule (a minute of
waits, more with 25 s timeouts) held the ship visibly at the end of transit, 27 s in the
playthrough with fast failures, and an hourly budget refusal would have waited up to five
minutes. Staging now has its own schedule, two retries after 2 s and 4 s, and falls back to the
floor set at once on the budget (D67's failure rule otherwise unchanged); after the change the
failing run fell back within 7 s with no visible hold.
*Holding for repairs held for ever* in tours that answered the departure gate with a hold: the
last repairer kept the ship's only stack of spares in hand through meals, sleep and rest, and
every other repair was blocked on an inaccessible supply. Finishing a task now sets its tools
and parts down as giving one up does (D64), and the crew are told where (a report, like D63's
freight brief), since the others last believed them in someone's hands.
*Found, not changed:* the generator's `electrical_short` needs a welder, which the ship does not
carry and only Ossory sells, so holding for that repair anywhere else never ends (every
remaining stall in the tours; content or departure-gate design). Three of the four 8x browser
sessions also ended holding for repairs, one for the fusion generator. At 8x the null narrator
answers at once, so the 30-per-hour story budget ran out four minutes into a session and the game
waited 30 s per retry (D43, not phase 3). A staging attempt that times out costs the narrator's 25 s
each; a staging-specific timeout would bound the hold (server and narrator side).
**D70. Phase 4 of Dockside: the captain goes ashore, and cards from the port come in person.**
Plan items 1–6 (design §6.2–6.4; owner ruling D57: "the captain should leave the ship to go look
for work, and [their] leaving the ship should trigger narration").
*Looking for work.* `lookForWork` is a personal activity the planner never chooses: commerce
(`systems/commerce/captain-ashore.ts`) hands it to the command actor (D8) at essential-operation
urgency, every tick until it starts, while docked at a port with a dock map, `captainIsIdleAt`
holds (it now also counts held cards), the personnel ramp is fully down and nobody is on the walk already,
and only once the actor is idle or passing the time ("they finish what they are doing"). The walk
goes to the foot of the personnel ramp; `captainAshore` (which replaces `jobBoard`; context: port
and the actor who went) is raised the tick they stand on dock floor, retried every tick while
another hook is pending, and `narrator.captainAshoreLastAsk` (was `jobBoardLastAsk`, same
lifetime) records port, tick and who went. If the captain is no longer idle before stepping off
(an offer or a course came up), the walk is cancelled and the ask stays unspent. On the dock the
activity waits (`awaitWord`) for the answer; with nothing held for them it goes on to a look
round: over to one of the dock's posts, half the time out through the gate for
`travel.gateVisitSeconds`, and back aboard. No second ask. A port with no dock map (hand-built
test content) has nowhere to walk, so the ask is raised on the first idle docked tick, as before.
*Cards in person.* While docked at a port whose dock is alongside, a card whose speaker is one of
the port's people (an offer's issuer; a narrator card's `speaker` who is not the name of any crew
member or passenger, wherever they are) is held: its decision record exists, pending, but it sits
in `decisions.held`, not the queue, so nothing halts on it and every reader of the queue keeps
meaning "on screen now" (Fable's review preferred this to a flag on queued cards: a reader that
missed a flag would halt on an invisible card). `core/delivery.ts` holds (`queueOrHold`, used by
`surfaceDecision` and `surfaceOfferCard`) and delivers (`deliverHeldCard`). Crew and passengers
bring cards as before, and so do observed scenes, in-flight cards, docks with neither the speaker
nor a gate, and kernel-raised policy cards (D37: brought by crew, unchanged). Delivery is one card
at a time, oldest first, and how is decided when the meeting starts, not when the card is held,
from where the walker is (whoever went ashore this docking, else the command actor): on the dock,
out through the gate or on the way, and they go (`meetSpeaker`: walk up beside a local on the
dock, `talk` for `travel.talkSeconds` ("talking with Fenwick Adair"), and the card comes up at the
`deliverCard` step; anyone else is beyond the gate: out through it for `gateVisitSeconds`, and the
card comes up on the way back in; then back aboard). With the walker aboard (a `quietTooLong`
offer while docked), the speaker comes: a local already on the dock walks to a free tile by the
foot of the personnel ramp, or someone from the port walks in from the gate as a `visitor` local;
the card comes up when they get there, after which a visitor goes back out and a local back to
their post. The local the captain is walking to stands still for it. The hand-out follows D61's
`comeAboard` pattern (re-handed until it starts); it gives way to anything at essential operation
or above and to the call aboard, and overrides routine work, since someone is waiting with word.
*Nothing waits forever, nothing goes stale.* A card held `travel.cardDeliveryGiveUpSeconds` (45 s)
comes up anyway (`cardDelivered`, reason `gaveUp`), and one whose port the ship is no longer docked
at comes up at once (`leaving`). An offer card whose job closed while it waited is dropped
(`decisionDropped`) rather than queued, since neither side could be answered and the world would
halt on it for good (Fable's catch); the server's card history forgets a dropped card that never
came up. Departure from the dock waits while a card is held (the travel gate and `setCourse`),
and so does a voyage at a waypoint. An interrupted walker (a survival need, an emergency,
incapacity, the call aboard) just stops; the next free tick the walk is handed out again, to the
first officer if the captain is no longer fit. A captain out through the gate is still fit for
command (`isFitForCommand`, now in `core/command-actor.ts`, shared by core and systems: it used to
be written twice), so going ashore never hands the ship or a card's perspective to the first
officer. Meetings are plain state, so a save mid-walk restores and finishes the same way.
*Offers never arrive in flight.* `offerJob` with `surface: true` is refused unless docked at its
origin (a quiet offer may still be posted anywhere, for scenarios), the translator drops an offer
in flight ("offers are made in person at the dock") and the digest says so; D42's
`Job.surfaceWhenDocked` and commerce's deferred-offer sweep are gone. Departing with a card held is
impossible by the gate above.
*Passengers.* A passenger who walked over with their offer (or a local of that name) becomes the
passenger on acceptance: the local goes and the passenger boards from where they stood, so the
dock never has one person twice.
*Log, headline, labels.* New notable events (never narrative, so they do not wake `notableEvent`
or reset the quiet timer): `lookingForWork` ("Mara Osei is ashore looking for work"),
`talkingWith` ("Mara Osei is talking with Fenwick Adair"), `wentToSee`, `cameToSee`; trace
`cardHeld` and `cardDelivered`. The docked headline reads "Docked at Crossroads Hub — Mara Osei is
ashore looking for work", or "… is talking with Fenwick Adair". Labels: "going ashore to look for
work", "looking for work", "looking round the dock", "going to see <name>", "talking with <name>",
"ashore to see <name>", "looking round the port". On the canvas a meeting label keeps the verb and
the other person's first name ("Mara Osei — talking with Fenwick", up to 34 characters); every
other crew label is cut at 26 as before. A visitor is drawn as any local ("coming over to the
ship"). No other renderer change.
*Narrator.* Prompt v0.19: `captainAshore` is the `jobBoard` text reframed (the captain has walked
out onto the dock; "On the dock" is who is there; the port lies beyond the gate; the issuer or
speaker named is who the captain meets; offer work, advance a ready thread from one of its people,
or deliberately nothing); a static rule says port people's cards are delivered in person while
docked and that work is only offered docked; `quietTooLong` says offers are never made in flight;
the capability list says the same. The hook line names who walked ashore. Held cards are listed
apart ("Cards on their way to the captain in person … not shown yet") and count as this call's
one card in the translator and the null narrator, which still offers work at the ask. Fixtures:
the captain stands at the foot of the ramp; `far-job-board.json` is `far-captain-ashore.json`. A
`visitor` local reads "came in from the port with word for the captain" under "On the dock".
*Save schema 6:* a pending `jobBoard` hook becomes `captainAshore` from the captain, and
`jobBoardLastAsk` becomes `captainAshoreLastAsk` with the captain as the one who went;
`decisions.held` starts empty; a `surfaceWhenDocked` offer (never carded, no decision record) is
withdrawn as expired at the save's tick (Fable's call: converting it would mean holding cards in
flight), and the flag is dropped from closed ones.
*Pacing* (`crew pacing`, stub narrator, 25 s latency). The script now waits for each port's ask to
be answered before it takes work or sets course, as a player answering the card would (the old
script set course before the tick-0 `jobBoard`, which only counted because it fired first). Calls
per round trip are unchanged: plain 8 (4 staging, 2 `captainAshore`, 2 quiet), freight 9 (plus
one notable), within D51's 10 and D65's 10. Sim time per trip: plain 478.8 s against 430.0, freight
532.8 s against 494.7; the difference is the captain's walk ashore and back before each departure
(the Hub leg 52 s → 75 s on the plain trip). The first call no longer costs a 25 s loading screen
at tick 0: it comes about 17 s in, when the captain steps off (the walk from the bridge), with a
17 s lead, so 8 s of stall at 1x and 23 s at 8x; every later call at 1x is fully hidden as before.
*Tests:* the walk and the one ask per docking, its tick and log line, the headline, the first
officer going when the captain sleeps, a card delivered on meeting a local, through the gate, by a
visitor and by a local walking to the ramp (and back to their post), no card in flight, a save
and restore mid-walk, the first officer finishing a walk the captain was taken off, the give-up
clock with nobody able to walk (`apps/web/src/worker/captain-ashore.test.ts`, real content); the
kernel integration run Hub → Kessler with the offer made in person by Hal Petrosyan at his kiosk,
loaded, delivered and paid once (`dockside.test.ts`); the 5 → 6 migration; surfaced offers refused
in flight; the digest, translator, null narrator and history over a held card; the canvas label.
*Live:* the live `captainAshore` case now asserts an offer from the docked port or a stated reason,
and logs whether the issuer is on the dock or beyond the gate. Not run: the OpenRouter key is at
its weekly limit.
*Merged with D69:* captainAshore is a story hook, so raising it settles a `pendingNotable` debt
like any story call, and an owed `notableEvent` (travel raises it first in the tick) simply makes
the ask retry the next tick; the walk waits on the dock meanwhile. D69's `finishActivity` setting
down a task's supplies does not touch the personal shore activities.
*Staging timeout:* a staging attempt now gives up after 10 s (`STAGING_TIMEOUT_MS` in the narrator,
the default when a `stageDock` call is given no timeout; the server's `CREW_STAGING_TIMEOUT_MS`
overrides it and the route passes it only for staging), not the story call's 25 s, which over
D69's retry schedule could hold the ship at the end of transit for over a minute.
*Browser verification* (dev servers on spare ports, null narrator, headless Playwright at 8x,
1280×800 and 390×700, about seven minutes each, fourteen dockings over the Hub, Green Meridian and
Kessler Drift): every docking asked once, on the tick the captain stepped off; eight cards came up
on meeting a regular at their post (Hal Petrosyan, Anneke Vos, Osric Tan, Greta Lindholm, Bo
Sandoval), six after the gate; once the captain was asleep and the first officer went; no card in
flight, no card dropped, no error panel. Found and fixed, each with a test:
- *The card came up ahead of the meeting.* The client showed a card once playback reached its
  `createdTick`, the tick it was held, so with the worker running ahead the card covered a captain
  still walking down the ramp. `Decision.deliveredTick` (set when a held card comes onto the queue)
  is now when the card is due and when the log shows it (`decisionShownTick`).
- *The label dropped the meeting while the card was up:* the walk back aboard began the tick the
  card came up, so the headline read "looking for work" over the card. `deliverCard` now stays
  current for that tick and names who the captain is with ("talking with Anneke Vos").
- *The log announced the offer before the meeting* ("X has freight for Y" the moment it was held):
  a held offer's `jobOffered` is trace; the card is its first word.
- *At a destination the headline hid the captain ashore* behind the unloading count; the ashore
  line now comes first while it lasts.
- *Offline, every offer came from beyond the gate*, so the talk was never seen: the null narrator
  now takes its issuer from someone standing on the dock (a regular, or someone staged there) half
  the time.
*Found, not changed:* a departure-gate "hold for repairs" at a port whose market sells no part for
the fault parks the ship until the narrator acts (D64); the hourly story budget (30) runs out in
about six minutes of 8x play because quiet check-ins come every 60 sim-seconds.
*Not done:* the design's phone playtest by the owner; the captain's walk is fixed (the bridge to
the ramp, about 17 s), not tuned.


**D71. A hold for repairs never waits on a repair the ship cannot do.** D69's found item: the
generator's `electrical_short` needs a welder, the ship never carried one and only Ossory sold
it, so holding for that repair anywhere else never ended. Two halves, per the team lead's
brief (the owner having delegated):
*Content.* The default scenario stows a welder torch in the hold's stowage beside the toolkits
(the Freighter Mk1 has no engineering stores zone), so every repair its machines describe can be
done from the start. Validation (L3) now requires every scenario to carry, among its starting
items, a tool of every kind a repair or inspection recipe on its deck names; the stricter of the
two candidate rules ("carried, or sold at some port") because a tool sold only at a far port still
leaves the repair impossible everywhere else. Markets may still sell tools, as replacements.
Old saves (schema 5) are not given a torch; the sim half covers them.
*Sim.* A diagnosed fault's repair is short of a *tool* when nothing aboard provides a kind its
recipe names (all its steps, as the repair task asks), wanted as one unit of the most specific
item def providing it (fewest tool kinds, then id). That shortfall is a `partsNeeded` like a part's
(D47, same payload), so the crew buy a lost welder at a port that sells one and a voyage waits at
such a waypoint for the purchase. The departure gate (D36) judges each impairment: *out of reach*
when a diagnosed fault keeping the machine impaired (any `derate`/`inoperable` fault, an
`overheat` fault while it is blocked or low on output) is short of a tool or parts that nothing
aboard covers and the market at the port the ship is at cannot sell in full now (out of stock, or
more than the ship can pay). The card offers a hold only for an impairment in reach (it names the
worst of those). When none is left there is nothing to choose, so no card: the departure goes
ahead, any hold ends, and `departureRepairOutOfReach` (narrative, in the default `hookOnEvents`,
so the narrator dresses it as it does "leave anyway") says why per machine: "No welder torch
aboard and none to be had at Kessler Drift: leaving with the fusion generator's electrical short
unrepaired". It is remembered as "leave anyway" is, against the live impairment set (no new state
field), so it is said once and a new fault or a repair asks again. A hold whose last in-reach
repair becomes impossible mid-hold (the only tool lost, the part sold out) ends the same way the
next tick. An undiagnosed fault is still work aboard (diagnosis needs no tool), so the gate waits
for the diagnosis before judging, and the card never claims what the crew have not found.
Chosen over releasing every hold after a timeout (it would cut real repairs short) and over a card
whose only side is "leave" (D36: do not bother the player when there is no choice). This narrows
D47's "the narrator stocks the part while the ship holds": a hold no longer waits on a part
nothing here sells; the hook tells the narrator, who can stock the next port. Not changed: an
engine or generator impaired by integrity alone, with no fault left to repair (only a completed
repair restores integrity, D35), still holds for ever if held for; no tour has produced one.

## 2026-10-04 — Ship life, slice 1: Freighter Mk2 and the hull contract

Design: `docs/design/ship-life.md` (owner rulings §13); plan: `docs/design/ship-life-plan.md`.
Built by a contract gate and six parallel workstreams, integrated by the team lead; the plan's
"Calls made" are adopted as written except where noted below.

**D72. The hull contract: bow east, quay south, ships berth in size-class boxes.** The owner
ruled bow east. Orientation is an invariant, not a parameter: the validator (L3, every deck)
requires that the deck fits its `hull.sizeClass` box (S 24×14, M 36×20, L 40×24), that a
`bridge` compartment touches the east edge (x = width−1), that both ramp doors face `s` from the
bottom row with their transfer tiles on or beside them, and that it has the rooms, stations,
zones and spawns ship life needs (bridge; quarters or a cabin; mess; galley; engineering; cargo
hold; airlock; exactly one `pilotStation` and one `navStation`; an engine, a mess table and a
stove; cargo stowage; crew and passenger spawns; every `locker` zone serving one bed by
`machineKey`). Per scenario: a crew spawn point per crew member, beds (never the medbay's
`medBed`) for crew + 1, and a ship whose class fits every dock's box. `hull` carries no ramp
slots: the ramp doors already say where the ramps are. Dock maps no longer draw the ship:
`berth: { origin, sizeClass }` replaces `shipAt` and the `berth` tile kind; the box must be on
the map and all `void`, the quay row under it walkable floor across its full width, and every
deck whose class fits the box must land both ramps on floor that reaches every post and area.
The ship's place is derived by one rule, `berthPlacement` (flush south, centred, an odd spare
column east), mirrored in content's `shipAtInBerth` because content may import only sim types;
a CLI test holds the two equal for every dock and deck. The six maps were re-authored with
2-tile side margins and at most 29 rows, so the docked phone camera stays above 12 px a tile;
posts follow the bow (gate, kiosk and benches by the personnel ramp, warehouse and bays by the
cargo ramp) except at Tern's Rest, where the long walk to the far end of the pier is the point.
Post keys did not change. In code, direction lives only in the renderer: `render/orientation.ts`
holds `FORE = +1`; the hull is drawn from the deck bounds alone (nose +x, bells −x), the scene's
"positive astern" offsets convert through it, stars stream toward −x, and the phone portrait turn
is now counter-clockwise so the bow still points up and the quay is on the right. The sim has no
direction. Three sim helpers that took the bundle's first deck now use `shipDeckId(state)`.

**D73. Freighter Mk2 is the default ship; Mk1 is mirrored and kept; Noor Haddad joins.** Mk2 is
ship life §8's 36×20 grid and door list with every room furnished: the bridge (helm with a
`standby` position below it, nav and ops terminals, captain's chair, two reserved bare tiles for
later stations), captain's, first officer's and two-berth passenger cabins, an eight-bunk
bunkroom, lounge, mess with two four-seat tables, galley, stores, gym, infirmary, airlock and
hold. The new furniture is inert content (ops terminal, chair, desk, games table, vid screen,
exercise rig, workbench, engineering console); the four terminals draw 0.2 kW of domestic power.
Placements moved from the plan where the plan blocked a door's inside tile or the helm's standby
(bunks in columns 14, 15, 17, 18; pantry up a row; ops terminal at (34,5)). `bridge_console` is
renamed `helm` now rather than in slice 2, the galley stove is tagged `stove`, and the medbay bed
`medBed`, no longer a place to sleep. Mk1 was mirrored by `scripts/mirror-deck.mts`, keeps no
scenario, and stays loadable so the berth box is exercised with two footprints; its spawns were
moved off interaction tiles. The ninth crew member is Noor Haddad, a relief pilot with piloting
3, on beta shift, so each shift has a qualified pilot until slice 2's watches replace shifts.
The narrator prompt says nine crew.

**D74. Berths by rank as a standing rule; lockers belong to beds; old saves are refused.**
`assignBerths` runs at world creation and every tick in the needs stage: captain's cabin, first
officer's cabin, passenger cabin, bunkroom, else any free bed outside the passenger cabin, else
unberthed (slice 4 gives that a thought). Rank first, then actor id. The dead, anyone removed
from the ship and a passenger left behind free theirs; someone briefly ashore keeps theirs. A
locker is the zone whose `machineKey` names the bed; each crew member's `personal` starting
items (the harmonica, the old photograph) start there with `ownerId`. People sleep in their own
berth or a bed nobody is assigned, never in another's (the planner reads
`AgentView.assignedBeds()`; the sleep plan refuses one as a second guard); no hot-bunking yet.
A sleeper in a cabin is labelled by the cabin ("asleep in the captain's cabin"), since content
has no pronouns. Save schema 7: a schema-6 save is refused with `SaveCompatibilityError` and the
host starts a new game, rather than migrating every tile-bearing field across a mirrored deck
and reshaped dock maps (PLAN §3 allows this before there are players); older migration tests
stop at schema 6.

**D75. The departure gate remembers its answer per machine and fault, not per reason.** Found
by the slice-1 test work on the Ossory passengers run: a generator with `electrical_short` (heat
rise 0.045/s against cooling 0.02/s) hovers at its temperature limit, blocked at it and low on
output just under it, so its reason flipped every couple of ticks. The remembered "leave anyway"
was keyed `machineId:reason` (D49, D71), so each flip dropped the answer and raised the card
again: 712 gate cards between ticks 4580 and 6186, which in play is a policy hook and a narrator
call every couple of ticks. The key (`impairmentKey`) is now each impaired machine with every
fault on it (`machineId:faultA+faultB`), which only a repair or a new fault changes; D71's "a new
fault or a repair asks again" holds, and a machine that stops being impaired still drops out.
Chosen over keying on the faults that keep the machine impaired (`heldForFaults`): that set
counts an overheat fault only while the machine is blocked or low on output, so a machine with
a derating and an overheat fault at its limit would flip it the same way. A new overheat fault
on a machine already impaired for another reason now asks again, as a new fault should. No save
carries the old key format: it ships with schema 7, which refuses older saves (D74).

The same pass made the kernel about twice as fast per tick on Mk2's 33 machines with identical
event logs and end states (a per-pass coolant index in equipment, a leaner A*, cached placement
lookups, and invariant paths built only on a violation). `crew pacing` on Mk2 against Mk1 at the
gate: plain 450.6 sim-s against 459.7, freight 536.5 against 532.9, the same narrator calls, the
1x stall 5.5 s against 8.1 s (the captain's longer walk ashore builds lead).

*D72 addendum (portrait layout), from the slice-1 browser QA.* The camera's legibility test fitted
the whole 390×700 window while the app gave the canvas only 390×382, so docked Mk2 drew at 8.3
px a tile with room labels dropping out. On a portrait screen the canvas now gets most of the
height: a one-row 36 px top bar, a headline fixed at two lines (so the canvas never resizes as
it wraps), and a compact log strip under the canvas, `clamp(44px, 100dvh − 660px, 160px)`, which a
toggle opens to the old 28vh at the cost of zoom. The fit pads 4 px instead of 12 when the deck
is turned. The sizes live in `apps/web/src/ui/portraitLayout.ts` and reach the stylesheet as
custom properties, so the test checks the canvas the app really lays out: at 390×700 every dock
frames above 12 px a tile (Hub 12.95) and flight at 12.6; landscape is unchanged. A person's
label is drawn only while their dot is on the canvas (no labels floating ahead of an arriving
dock), and a room's plate only when it fits inside that room on screen. The same pass fixed
pause, which stopped the worker but not playback (seconds of buffered movement kept playing):
`FramePlayback.setPaused` freezes the view on its last frame. "Noor" left the locals' name table
(replaced in its slot by "Ines"), and validation now rejects a generated given name equal to a
crew member's first name.

## 2026-10-04 — Ship life, slice 2: the watch and the helm

Plan: `docs/design/ship-life-plan.md` (Slice 2). Built as two serial gates (day units, then
contracts) and six parallel streams, integrated and tuned by the team lead.

**D76. Time is counted in fractions of the ship's day; fast play slows for what matters.**
`time.daySeconds` (1200) and `time.watchesPerDay` (3) are the two knobs. Need rates are authored
per day, and meal and sleep length, offer lifetime, re-offer cooldown, passenger time ashore and
overdue, the quiet window and the budget refill in days (`Days`, beside `Seconds`), converted
where read by `core/clock.ts` (`daysToSeconds`, `dayTicks`, `perDayToPerSecond`, `watchTicks`,
`watchIndexAt`, `watchOfDay`), not at load, because the config is embedded in every save as
authored. Motion, doors, docking stages, dockside timings, work at a machine, machine defs, host
real time and `narrator.maxFaultWindowSeconds` stay in seconds, so changing the day rescales the
routine while walking keeps its speed. The conversion was exact at 1200 s (`crew pacing` identical
to the tick). The renames needed no migration: `restore` fills missing config keys from content
(`fillConfig`), and the narrator's snapshot upgrade and the narrator-log rebuild do the same. The
three spur legs are 400 both ways, one watch at nominal speed, so a handover happens at sea; pay
stays band × path distance, so a spur job pays about 3× its old total at the same rate per
transit second (left to judge in play). Fast-forward drops to 1× when *playback* reaches an event
on `host.slowDownOnEvents`, naming it with the ticker's own text in a toast and a highlighted log
line; nothing happens at 1× or while paused. The clock reads "Day 2 · White watch" ("White"
below 390 px). `crew beats` runs the pacing voyage for N ship's days with an instant narrator and
reports beats per watch, each person's share of time by activity, longest idle stretches and
helm-empty time; it is the tuning instrument. The tuning commit set sleep to 0.2 day (recovery
4.25/day), the quiet window to one watch, and added one planner rule: someone on duty does not go
to bed while tiredness is only routine, so each section sleeps in the same off-watch window every
day (Red from about 410 s into the day, White and the dayworkers from about 810 s). Measured over
three days: 3 bells and about 3 handovers a watch, one 240 s sleep a day each, quiet-too-long
calls from ~15 a voyage to 1, the 8× narrator stall from ~450 s to ~180 s.

**D77. Watches replace shifts; the helm is the duty station.** Three sections on a watch bill
authored in the scenario (section i stands watch i; Red = Noor, Mara, Priya; White = Jax, Tomas;
Blue = Dane; dayworkers Bettina, Sunniva, Oyelaran on watches 0–1), the bell in the ticker,
`CrewDef.shift` retired; a bill-less scenario (fixtures) gets a greedy generated bill. The
validator requires one section per watch, each with a member meeting the helm's
`operatorSkill`, and a scenario of more than three crew to author its bill. Who has the helm is
physical: the crew member in a staff hold on its seat (`whoHasTheHelm`). The sim designates the
stander (`helmRoleOf`): the section's qualified non-officer, then its qualified officer, then the
nearest qualified hand aboard, then piloting ≥ 1 (visible to the narrator as an unqualified
hand); while the helm is empty only someone free to come is designated, so an idle qualified hand
is never passed over for a busy or sleeping one (the slice-1 QA case). The planner reads only the
role; helm posts and the course plot skip `deferTo` and the off-duty rule. Handover: 30 s before
the bell the oncoming goes to the standby tile, counts 5 s while the seat is held, the off-going
steps off and the oncoming sits; an empty helm is simply taken. Relief: a stander whose need
passes essential raises a routine relief post an off-watch qualified hand fills until the stander
is back. Vacancy gates departure prep, the end of transit, the approach and docking, and nothing
else; after 20 s empty in transit `helmUnattended` fires once. In port the helm watch opens once
the course is plotted; until then the section's non-officer stander stands gangway watch at the
airlock. The officer of the watch walks rounds (engineering, hold, mess, the helm's standby;
start-to-start cadence `roundsEveryDays`) and idles at the captain's chair, never pinned; idle
on-duty engineers walk the engineering machines; perception does the noticing. Piloting is
learned only at the helm. Measured: the helm empty about a minute in three days while not docked,
almost all of it the walk up at the start of departure prep.

**D78. Course plotting and piloting checks.** `setCourse` and each voyage hop leave the course
unplotted; travel raises `courseToPlot` per destination while a nav terminal is aboard, deriving
one essential `plotCourse` task at the nav station that needs the helm's `operatorSkill`; skill
sets how long it takes, and departure prep waits for it beside the departure gate. A detour
re-raises it; a hold for repairs keeps the plot. The narrator's sixth lever is `scheduleHazard`
(prompt v0.21): a kind (debris field, asteroid belt, ion storm), a tier (easy/hard/brutal →
`config.hazards.difficulty`) and a fault-window word. The translator spends the hazard budget,
lets one hazard wait at a time, and places it only on a leg with transit ahead. The sim fires it
at the first transit tick at or after its time and rolls the stander's piloting against the
difficulty, p = clamp((skill − difficulty + 5)/10, 0.05, 0.95): a clean pass, else evenly a scrape
(one fault scheduled through the single fault path, D6) or a delay (the leg set back, never past
its start); an empty helm is a scrape and a delay. A hazard whose leg ends first, or whose course
is given up in port, is dropped with `navHazardMissed`. `scheduleFault` now spends
`faultsRemaining` and is refused at zero, and the budget refill D6 promised runs. The digest
carries the watch, who has the helm since when, the officer of the watch, the gangway, the next
bell, each helm check, empty-helm spells and the hazard budget.

**D79. Thoughts and mood; schema 8 migrates.** Thoughts are a closed key set in the sim with a
required content table (label, value, duration, stacks); the first four are "stood a long
watch", "double watch", "brought the ship through clean" and "scraped the ship through". Mood is
the clamped sum of live thoughts; `addThought` updates it at once and the needs-phase
`moodSystem` lets thoughts wear off, so mood always equals its thoughts at the end of a tick; a
non-stacking thought (matched by key and `refId`) extends its expiry. Work speed is the only
effect yet (0.9× below −0.4, 1.05× above 0.4). The digest and the inspector show mood as a word
with the three heaviest thoughts. Save schema 8 migrates schema 7 (sections from the bill by
crew def, empty thoughts and hazards, the hazard budget line) rather than refusing it.

**D80. The ship keeps stores, limps when it cannot repair, and a starved machine waits on its
cause.** The slice-2 integration runs (`crew beats --days 3 --scenario both`) hit three dead
ends, each fixed with the smallest rule that keeps play going. *Food.* The default run carried
40 ration packs for nine people eating about four a day each, so everyone's hunger sat at 1.0
from day 1.5. The scenario now stows 220 (about six days), ports stock enough to restock, and
Kessler Drift's canteen sells them. Commerce keeps stores through one routine problem,
`reserveLow {itemDefId, count}`, raised only while docked at a port whose market has the item in
stock and recounted against what is aboard every tick; it derives D47's `buyParts` task through
a `buySpec` shared with `partsNeeded` (task target kind `market`). Food is counted in days
(nutrition aboard ÷ eaters × `hungerPerDay`): below `commerce.foodReserve.lowBelowDays` (2) the
crew buy up to `restockToDays` (5). A restock never holds a departure; the next port that sells
food asks again. Slice 3's `provisionsLow` has the same shape and replaces the food rule.
*Spares* (extends D47): the ship keeps `commerce.sparesReserve` (3) of each `spare`-tagged item
the same way; with 2 the freight run still ran out on the Ossory leg. *Limp* (amends D64, whose
"parks the ship until the narrator acts" cannot happen at sea, where the narrator has no lever):
when every engine wanted on is impaired by a diagnosed fault whose repair nothing aboard can
finish, the ship moves at `travel.limpSpeedFraction` (0.2) of nominal, sets `travel.limping` and
says so once (`shipLimping`, narrative, hooked); while a repair aboard could still restore the
engine, the ship drifts and the crew work, as before. Chosen over a parts-delivery lever (D47: no
deliveries) and over ending a drift on a timer. *Reach through dependencies* (amends D71): an
impairment with no fault of its own caused by another machine's (a consumer starved on a bus
whose generators are impaired, a machine derating hot on a bus whose cooling is off) is out of
reach only if every cause is; the reason given is the cause's fault. With no cause to point at,
D71's "in reach" stands. Found: a coil burnout at Kessler Drift, which sells no spares, starved
the engine to 0.167 output and held the ship for good. Measured after: two round trips in three
days on both scenarios (one before), no one at hunger ≥ 0.9 (45% of person-time before), every
hold lifted, about 110 s adrift in three days. The captain's share of the helm fell from ~28% to
~10% once starving standers stopped calling relief.

*D76 addendum (slice-2 QA).* Fast-forward slows only for news the player should stop for (a
hazard, an empty helm, the engines going down, the limp), not for faults the crew handle or the
engines coming back, and not again within 120 s of view time after a slowdown; the line it
lights leads its tick in the log and clears after 8 s or at the next slowdown. Measured: about
1.2 slowdowns a watch at 8× before, 0.1–0.3 after. Person labels are placed to avoid each other,
room plates and machine names (shortening to "Jax — relieving Noor" in a crowd), and the
inspector says roles and known problems in words, once per kind, at the tick tapped.

*D77 addendum (slice-2 QA).* The browser QA found Blue, Dane alone, leaving cargo untouched for a
whole 400 s watch when the ship docked in it, and the helm's designation, relief and sleep
churning near the bell. Cargo in port is all hands awake, not the watch's: `cargoToLoad` and
`cargoToUnload` skip the off-duty rule, and sleepers sleep on. The bill puts a non-officer in
every section (Blue = Dane, Sunniva; dayworkers Bettina, Oyelaran), and gangway watch is the
on-watch section's non-officer's (the helm's stander when that is one, else its best pilot),
since it needs no piloting. The bell pulls people, not the moment's state: no relief is raised
within the handover lead plus `reliefNoShowSeconds` of the bell (the oncoming relieves); someone
walking up to an empty helm stays designated until they sit or drop it, and a better-placed hand
relieves them by handover; someone already in the seat changes posts without a handover or a
"takes the helm". Sleep is anchored to the bill: routine tiredness is slept off in one's sleep
watch (the watch after one's own; for a dayworker the first watch off after their last on), from
`needs.bedtimeAbove` (0.3); outside it only pressing tiredness sends anyone to bed; a sleep is
interrupted only by containment or above; standing at the helm or the gangway tires at the awake
rate. Rounds are walked aboard, never from the dock. Measured over three days: the Blue cargo
stall from 322 s to 4 s, the helm empty 54–81 s while not docked (from 85–96), sleep starts
within about ten seconds of the same time of day for everyone from day 2, and 2.6–3.0
handovers a watch (one at the bell, the rest meal reliefs). Not changed: with a course plotted,
the stander sits at the helm through a docked repair hold.

*D70 addendum (slice-2 QA): the ask is never spaced.* At a destination the captain can step onto
the dock a few ticks after another story call (in QA, 29 ticks after the delivery's
`notableEvent` at Kessler Drift); the server refused that `captainAshore` under the 100-tick
spacing rule, the client acknowledged it unanswered (D43), the docking's one ask was spent on
nothing, and the ship was "looking for work" for the rest of the session. `captainAshore` joins
`policyDecision` in `SPACING_EXEMPT_HOOK_KINDS`. The rule: the server spaces only hooks the sim
raises again on its own (`quietTooLong`, `notableEvent`), where a refusal costs one check-in; a
hook raised once is never spaced. The hourly cap still applies (D69), and the ask still counts as
the last call for spacing the next. A client retry after the window cannot work (the world is
halted on the hook, so its tick never passes the window), and a sim re-ask timer was withdrawn by
the D46 amendment. Found, not changed: offline, passing on a port's only offer leaves nothing to
ask for until the player acts.

*Slice 2 shipped with these known issues (QA, not fixed):* Jax, White's stander, sometimes goes
to bed from the helm on his own watch after a relief (pressing tiredness); "takes the helm" lines
repeat around port calls as the stander walks to the helm at docking and leaves for the gangway;
at 390 px a crowded handover label can cover the BRIDGE plate; rounds sometimes route briefly out
through the airlock and along the dock; the narrator's hourly cap (30) still stalls 8× play after
about six minutes (D69); dayworkers are idle about half the time until slice 3 gives the cook and
medic work.
