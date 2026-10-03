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
