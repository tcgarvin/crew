# Dockside: Implementation Plan

Status: plan, 2026-10-03. Design and rationale: `docs/design/dockside.md` (section references
below are to that file). Four phases. Each one ends deployed, with all checks green
(`pnpm typecheck && pnpm lint && pnpm depcruise && pnpm test`), a phone playtest, and a pause to
take stock before the next phase starts. Each phase adds its own `D<n>` entries; D57 records the
owner's rulings from the design.

## Phase 1: Motion (presentation only)

The sim does not change apart from three render-frame fields. No save-schema bump. This gives
the starfield the owner asked for, and every later phase draws on top of it.

1. **Render frame.** `RenderFrame.travel` gains `fromPortId`, `toPortId` (the dock port when
   docked) and `drifting` (`core/render.ts`, `core/types/view.ts`, and the protocol type if it is
   restated there). Tests in `core/render.test.ts`.
2. **Port setting.** `PortDef.setting: "station" | "planet"` (Zod schema, the generated JSON
   schema, and all six ports). Green Meridian is set to planet, and its `description` and
   `character` are rewritten as a farming world with a spaceport. This touches narrator-facing text,
   so run `pnpm test:live` once.
3. **Scenery module** `apps/web/src/render/scene.ts`: a pure
   `sceneAt(travel, ports) → { skyColor, starSpeed, starAlpha, portOffset, portScale, cloudBand,
   plume, cameraT }`. Unit tests at every stage boundary and for continuity across
   `approaching` → `docking` → `docked`, and across `undocking` → `departing` → `transit`.
4. **Stars** `render/stars.ts`: a fixed-hash field in two or three parallax layers, scrolled by a
   client accumulator driven by `starSpeed`; wraps; static under reduced motion.
5. **Hull and plume** `render/hull.ts`: a silhouette from the deck bounds (nose fore, bells aft);
   plume length from `plume` multiplied by the engine's render state.
6. **Port scenery**, still without dock maps:
   - station: an outer structure that grows on approach, and bay walls that slide past during
     docking and departing;
   - planet: the disc, the sky gradient, cloud bands in the foreground with alpha, and a pad under
     the ship when docked.

   Both use stand-in palettes, replaced by the dock maps' palettes in phase 2.
7. **Ramps:** `doors.rampOpenSeconds` in config (Zod and the default value), used by the door
   system for `kind: ramp`; ramp drawing as an extending plate or gangway, by open fraction.
8. **Layering in `drawFrame`:** sky, stars, far scenery, hull, deck, foreground. Portrait
   rotation applies to every layer.
9. **Camera:** flight framing with a margin. The docked fit waits for phase 2, which has the
   bounds; in phase 1 the camera stays on the ship.

Checkpoint: a hub → Kessler → hub loop on a phone looks like travel. Measure frame time on a
mid-range phone with the new layers; if it is heavy, cache the static layers to an offscreen
canvas.

## Phase 2: Dock maps and physical port work

Save schema 3 → 4.

1. **Spike: the dock as a nav area** (§3.4). Prove portal edges between two nav areas in
   `systems/spatial` (`topology.ts`, `pathfind.ts`, `routing.ts`, `reservations.ts`): a path from a
   deck tile, through an open ramp, to a dock tile; occupancy and passing work across the portal;
   a closed ramp blocks it. Decide between portals and grafting dock tiles onto the ship's grid
   here, and record the choice as a D entry. Write it up before building on it.
2. **Deck change:** move `personnel_ramp` to the airlock's south wall; update spawn points and
   transfer tiles; regenerate the deck README; fix the tests that pin its position.
3. **`DockDef` schema** in `packages/content/src/schemas/dock.ts` (§3.1), the bundle and loader
   wiring, the generated JSON schema, and the validator rules (landings, reachability, posts,
   areas, size cap). `castSeed[].post` (optional, must name a post on that port's dock).
4. **`crew content render-dock`** in `apps/cli`, writing an ASCII map and README next to each dock
   file.
5. **Six dock maps** (§3.3), each with its README. Authoring is the bulk of this phase. Do the
   Crossroads Hub dock first, playtest it, then the other five.
6. **Dock lifetime in the sim:** created at the start of `docking` from the dock map, removed at
   the end of `undocking`; walkable only while docked with a ramp open. Render projection:
   dock id, dock items, and actors on the dock.
7. **Physical cargo** (§4), in `systems/commerce` (`jobs.ts`, `tasks.ts`, `commerce.ts`):
   - freight staged on offer, carted back on decline or expiry (until locals exist in phase 3,
     the crates simply appear and vanish);
   - `cargoToLoad` from the staging area, with carrying and hand-truck use;
   - delivery custody in the delivery bay, then removal on completion;
   - `buyParts` at the stall, or through the gate when the dock has no stall;
   - passengers walk to and from the gate.
8. **Departure prep** waits for everyone due aboard and for no accepted freight left on the dock;
   the headline gets "Waiting for <name> to come aboard".
9. **Migration 3 → 4.** A save docked mid-loading moves its warehouse-store freight to the
   staging area. A save docked with nobody ashore gets its dock built on load. An actor standing
   on an old personnel-ramp transfer tile is left there, since it is still floor.
10. **Renderer:** the dock layer at `shipAt` plus `portOffset`, its palette, props and
    foreground; the camera eases to ship plus dock during `docking` and `undocking`; the
    inspector handles dock items.
11. **Narrator digest:** freight on the dock and the dock's ambience line, read-only. Prompt text
    is unchanged in this phase.

Checkpoint: a freight loop with crew walking out to fetch crates and down to deliver them, at all
six ports. The kernel integration test from §10 passes, without the locals.

## Phase 3: Locals and the staging call

Save schema 4 → 5 (locals in state; they exist only while a dock does, so the migration is
trivial).

1. **Locals in the sim** (§5.1): a new actor kind or flag, excluded from tasks, posts, needs,
   perception subjects and the roster; scripted behaviours (`atPost`, `walkTo`, `leave`); visible
   to the planner only as obstacles through `AgentView`. Invariants: no local without a dock; no
   local on the deck.
2. **Floor set** (§5.2), computed at the start of `docking`: regulars at their posts, the job's
   receiver or issuer, a passenger due back, a left-behind passenger.
3. **Dock hands** take over the carting from phase 2 (offer staging, decline, post-delivery
   removal).
4. **`stageDock` hook:** raised `approachHookLeadSeconds` before transit ends; travel holds in
   `transit` until it has been raised and answered (§6.1). Tests include another hook already
   pending, and a drift during the hold.
5. **`stageDock` command** (the kernel side of the staging plan): place people (cast, seed, or new
   face) at a post, place unowned props in staging or by a post, log an ambience line. It is in
   the authority table as a staging-only command; the kernel rejects it outside the hook's window.
6. **Narrator package:** staging system prompt, schema, translator (it drops every non-staging
   intent with a reason, and notes pass through untouched); an "On the dock" digest section for
   every docked call; fixtures; contract tests. Prompt v0.17.
7. **Server:** route handling for `stageDock`. On failure, retry per D43, then acknowledge with the
   floor set and log `[narrator] staging fallback <reason>`, with no error panel. `narrator_calls`
   records staging calls with their kind. The `notes` write path is skipped for this kind.
8. **Remove the story side of `approachingPort`.** The hook kind is retired or renamed (decide in
   the D entry). Update fixtures, digest hook lines and the null narrator.
9. **Null narrator:** stages nothing, leaving the floor set.
10. **Renderer and inspector:** local dots, labels, tap for name, role and post.
11. **Live suite:** one `stageDock` call; try a cheaper model there and record the result.

Checkpoint: land at the hub and Hal is at his kiosk, the narrator's people are where the story
would put them, and no card appears on arrival.

## Phase 4: The captain ashore

Save schema 5 → 6 (`jobBoardLastAsk` becomes `captainAshoreLastAsk`). Landed as D70 (playtest
pending; `pnpm test:live` not yet run, the key being at its weekly limit).

1. **`lookForWork` task** for the command actor when docked, idle (`captainIsIdleAt`), with a ramp
   open, at essential-operation urgency; it walks to the dock and fires `captainAshore` on the
   first dock tile. Once per docking.
2. **`captainAshore` hook** replaces `jobBoard`, in sim hook kinds, config (`hookOnEvents` where
   relevant), narrator prompts (reframed `jobBoard` text plus "On the dock"), fixtures and the null
   narrator.
3. **Card delivery on meeting:** a card whose speaker is a local on the dock is held until the
   captain reaches them and talks for a few seconds; otherwise the captain goes through the gate,
   is `offShip` for a few seconds, and the card shows on return. The same mechanism serves
   `quietTooLong` offers made while docked (the speaker walks in to the ramp). D42's
   `surfaceWhenDocked` is migrated and retired.
4. **Captain with nothing on offer:** wanders the dock, maybe steps through the gate, returns. No
   re-ask.
5. **Headline and log lines:** "Mara Osei is ashore looking for work", "talking with Fenwick
   Adair".
6. **Pacing:** re-run `crew pacing` and compare with D51; record the result in the phase's D
   entry. Prompt v0.18 and `pnpm test:live`.

Checkpoint: a full round trip where every offer arrives in person, nothing arrives in flight, and
the call count per trip is within D51's budget.

## Risks and things to watch

- **Phase 2 is the big one.** The portal spike decides its cost. If portals turn out invasive,
  grafting dock tiles onto the ship's grid while docked is the fallback (simpler, but it makes the
  deck's dimensions dynamic).
- **Dock map authoring time:** six maps by hand. Keep them small. The first one sets the
  template; the rest are variations.
- **Run-ahead and the `stageDock` hold:** at 8x the narrator is already the clock (D51), and a
  guaranteed hook per docking adds calls at waypoints that were silent before. Watch the pacing
  numbers.
- **Phone legibility** when docked and zoomed out to ship plus dock. The size cap is the lever.
- **Save migrations** across three bumps. Before players exist, wiping is allowed (PLAN §3), but
  the migrations are cheap enough to write.
