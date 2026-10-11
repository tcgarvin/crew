# Decisions

The choices that shape the design, with what was rejected and why. How each mechanic works is in
`docs/spec/`; this file holds only what someone would otherwise reopen. Owner = project owner.
Numbers are permanent and never reused; gaps are entries that were folded into the spec (their
text is in git history before the spec existed).

A new entry is a few lines: the choice, the alternatives, the reason (quote the owner when the
words are the reason), and the `§` sections it shapes. Most work needs no entry; see
`docs/spec/README.md`.

## Platform and architecture

**D1. TypeScript end-to-end.** The kernel is a pure package with no runtime dependencies, so it
runs identically in a browser worker and in Node. Python was the alternative; nothing the
narrator needs is Python-only.

**D2. Vercel + Neon; a Vite SPA and Node functions; no Next.js.** A canvas game plus a JSON API
gains nothing from server components or ISR.

**D3. The simulation runs in the browser, in a Web Worker.** The save is the serialised state.
Owner: "okay with running everything in the front end… we could move stuff between front and back
end easily later." The kernel stays host-agnostic, so a Node host runs it headless for tests and
could take authority later.

**D4. Determinism is not a goal.** Owner: "The determinism is not important… we're going to spend
a lot of time debugging the implementation of sin." Rejected: replay from inputs, state hashes,
cross-engine determinism, fixed-point maths, golden-hash tests. Kept because they cost nearly
nothing and keep tests stable and bug reports useful: seeded random streams stored in state, no
`Math.random` or `Date` inside the kernel, JSON-safe state.

**D13. Content is data from day one.** Zod schemas over JSON; hand-authored and generated content
share one validator.

**D14. Run-ahead with buffered playback.** The worker simulates ahead of the viewer, up to a cap,
and stops at the next hook; the main thread plays the buffered frames at human speed, so a
narrator call's latency overlaps the viewer's catch-up. Safe without determinism because the sim
runs exactly once and the viewer only watches a delayed stream. It depends on the player acting
only at hooks, where the sim is paused: any future direct player input must itself be a hook.
Accepted cost: everything the player sees (inspector, log, cards) is keyed to view time so the
future never leaks. Owner proposal.

**D15. LLM calls go through OpenRouter.** Owner decision: the OpenAI-compatible API with a
configurable model, not a direct provider SDK, so models can be swapped by configuration.

**D23. The API ships as a bundled Build Output API function**, not a zero-config `api/` file; see
`docs/DEPLOYMENT.md` "The Vercel function".

**D59. The dock is grafted onto the ship's grid, not joined by portals.** While a dock is
alongside, its floor is stamped into the deck's nav grid in the deck's own frame: one grid, one
coordinate frame. Portals (the design's first recommendation) would have needed an area tag on
every bare tile coordinate outside the spatial system (routes, tasks, claims, plans, the agent
view), a change the compiler cannot find; portals in a shared frame add a second grid for no
gain. Cost accepted: being on the deck no longer means being aboard. A multi-deck ship may still
want portals between decks. See §the-graft-onto-the-deck-grid.

## The narrator

**D5. The narrator is hook-driven and synchronous.** The sim pauses at authored hook points, the
server calls the model, and the returned commands apply at the pause tick. Owner: "I don't think
we need to solve latency right now." Rejected: validity windows and a cadence table. Latency is
hidden by run-ahead (D14), not solved.

**D6. The narrator's authority is a mechanical allow-list**, not a prompt instruction: boundary
spawns, faults on machines with the kernel sampling the tick, messages through in-world channels,
jobs within price bands, decisions, bounded nudges, and the few levers added since by owner
approval. No command sets a body, health, position, knowledge or money directly. Adding a lever
is an owner decision. *The content ban ("No command sets…") is superseded by D106; the
allow-list stands.*

**D40. The narrator is the only source of work.** There is no deterministic job board; the
narrator offers work when the captain looks for it, and the null narrator answers with a
templated offer only in tests and explicit offline play. Owner: "let the narrator figure that out
dynamically as part of its arc generation."

**D43. No offline narrator for players.** In production a failed model call is an error, never a
template card: the client retries and then pauses the game on an error panel. Owner:
"retry/delay or in the worst case pause the game with an error message." The one exception is the
staging call (D57), which falls back to the floor set.

**D46. Pacing is the narrator's judgement, not a state machine.** The narrator decides from what
the captain has seen whether the story needs work, a thread beat, a breath or nothing. Rejected:
timers that re-ask for work and ordered menus of what to do when quiet. Owner: "I don't want the
narrator to think we are asking it specifically to solve that problem."

**D53. The plan schema rides in the prompt, not in a grammar.** Strict structured output compiles
the schema into a grammar with a provider size cap; the plan sat on that cap and every new lever
would have cost a schema redesign. The schema is the last cached system block and our own
validation is the only check. One tool per intent was the owner's general preference and remains
the likely next shape.

**D54. There is one kind of card.** A story's ending, a beat and an offer are all ordinary cards;
a separate "job done" or "story's end" card type was tried and rejected. The narrator is
responsible for closing its own arcs.

**D57. Dockside rulings.** Owner: one authored dock map per port; the captain walks ashore to
look for work and that walk triggers narration; the call that decides who is on the dock when the
ship lands only sets the stage (no card, no notes), and its failure falls back to the sim's floor
set rather than pausing the game (the exception to D43); cards from the port's people are
delivered where the captain meets them. See `docs/spec/dockside.md`.

**D102. No narrator call cap in software; one default model.** Owner: the cap is "really just
there to save the wallet", and the OpenRouter key has its own credit limit. A cap can return,
application-wide and far above the worst case, if that stops being enough. The story-call spacing
rule stays because it paces the story, not the budget.

**D105. The narrator decides whether a sneak-in works.** Owner: "There should be an opportunity
for the narrator to let the crew sneak in. For example if the player picks the right option, the
narrator says they sneak in and get the box, but another option the narrator triggers defenders."
A new lever (D6): while an expedition's arrival card is pending the narrator may mark one side,
never a `hold`, as the way in unseen (`markUnseen`); the captain still chooses, and the sim fights
the chosen side unseen or expected. Rejected: leaving noticing to the sim alone, which gives the
story no way to set up a quiet way in, and letting the narrator choose the plan. See
§getting-in-unseen, §unseen-lever. *D106 and the owner's odds ruling ("constrain the narrator as
little as possible") make the mark a chance: the narrator names the odds, 0 to 100, and the sim
rolls them when the captain takes the marked side (§unseen-odds).*

**D106. The narrator may decide outcomes; it may not do the impossible.** Owner: "the narrator
can't do anything impossible. But it can and should influence the sim and bend it to its will when
needed … The sim exists to service the narrative and bring it to life and to add some spice and
structure, not to try to limit the narration." Supersedes D6's content ban and amends D103's
"never scripted by the narrator": the allow-list stays, each command vetted by the translator and
the kernel, but it may now set an outcome (a wound or death, a sum of money, a memory between two
people, a roll's result, a fact learned). "Impossible" is the kernel's word: the actor exists and
is alive, the post is on the map, the balance covers it. Odds on a card side are the narrator's
stated chance, 0 to 100 and unclamped, rolled by the sim when the captain chooses. Rejected: a
narrator that only sets things up, which left a planned death a hope; direct state writes with no
allow-list. See `docs/design/narrator-arcs.md`.

## Play

**D7. The player's map shows truth.** Owner decision: one render layer. A per-person view is a
possible later feature. The agent-view boundary stays because it drives crew behaviour, not
because of rendering.

**D8. When the captain is asleep or incapacitated, the player's perspective passes to the first
officer.** Owner decision.

**D9. No save-scumming.** One linear timeline per game.

**D10. Time is a gameplay knob, not a fictional ratio.** Owner: "It's not about measuring time…
it just has to be playable." No mapping from sim seconds to fictional time is required to be
self-consistent; durations are tuned for a 10–30 minute session.

**D49. On a voyage the sim picks the next hop.** A course may name any reachable port and the
ship routes itself, stopping at real waypoints. Rejected: the captain choosing every leg, which
costs a narrator call and a card per waypoint while the captain acts only through cards (D14).

**D50. A passage is a job with a person in it.** No separate passage entity: the passenger is the
job's issuer, their luggage is its cargo, and one job at a time applies, so a passenger competes
with freight for the ship.

**D103. Expeditions: the ship sets down, people can die, the captain leads.** Owner rulings on
`docs/design/expeditions.md`: a site is a landing the ship sets down at, its own destination with
a pad, not a place beyond a port's gate; crew and the captain can die, tuned rare, never scripted
by the narrator, and a dead captain's command passes to the first officer (D8); kill jobs are
allowed from the start, rare and dirty; the captain leads the away party. Rejected: sites reached
on foot through a port, wounds that never kill, kill jobs held back to a later phase, a party sent
without its captain. Why: the owner wants a place the ship goes, a fight with stakes, and the
captain where the cards are. See §landing-sites, §going-down-and-death, §who-goes. *"Never
scripted by the narrator" is amended by D106; the rest stands.*

**D104. A kill job's target taken alive is executed.** Owner: "Kill jobs should end in an
execution if kills never happen." The party still never fires at an unarmed target in the fight;
once the target gives up, whoever leads executes them and the errand is brought dead. Rejected:
paying a kill job for a live delivery, failing it, and shooting the unarmed in the fight. See
§settling-the-errand.
