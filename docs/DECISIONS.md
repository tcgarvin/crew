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
