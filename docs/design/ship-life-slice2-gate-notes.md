# Ship life slice 2: Gate B as built (for the workstreams)

Gate B is commit 5db2860 on `ship-life-2`. The plan (`ship-life-plan.md`, Slice 2) holds except
where this note says otherwise. Delete this file when slice 2 merges.

## Departures from the plan

1. `Schedule.section` holds `{ key, index }`, not a bare key: `isOnDuty(schedule, tick, config)`
   needs the section's place in the bill. `self.watch.section` in the view is still the key.
2. `generateWatchBill` (stub), `resolveWatchBill` and `sectionsByCrewDef` live in
   `core/watch-bill.ts` (core never imports systems). `systems/watch/bill.ts` re-exports the
   generator and holds `watchBillOf`. **W1 owns `core/watch-bill.ts`.**
3. The `staff:watch` task still has 1 worker slot: two slots under the stub's open claim rule sent
   a second idle hand to sit at the helm. W1 sets 2 together with `helmTaskAllowed`. The skill
   requirement (operatorSkill, min 1) is in.
4. The off-duty/`deferTo` exemption is a second stub, `helmTaskExempt` (returns false), in
   `planner/helm.ts`, beside `helmTaskAllowed`.
5. `whoHasTheHelm(state, content)` takes content (the seat tile needs machine defs).
6. `helmManned(state, content)` and `helmMachine(state, content)` (moved); `travel.ts` still uses
   the machine id for `updateStaffingProblem`.
7. The `navHazard` payload has `scrapedMachineId?` and `lostSeconds`.
8. The "waiting on a course" headline keys on an open `courseToPlot` problem, not the flag.
9. `MigrationContext` has `config` (save config filled from content) and `scenarios`; `restore`
   fills config before migrating; narrator `run.ts` and server `narratorLog.ts` pass it.
10. The 7→8 migration sets `owner`/`post` on every `stationToStaff` problem and renames the task
    derivation key `staff` → `staff:watch`.
11. The tiny fixture's default day is 600 s with 2 watches; its bill is `alpha`=[Mara] with
    `dayworkerOnWatches: [0]`. `clock.test` passes 1200/3 explicitly.
12. Travel fixture crew are all dayworkers on `[0, 1, 2]` (always on duty). Crew-deck: crew2 is
    `alpha`=[Mara, Jon]; crew8 is `alpha` (Mara, Jon, even extras) and `beta` (odd extras).
13. Added: a `thought` entry in `DEF_SCHEMAS`; L2 checks on thought keys and dayworker watches;
    shared fixture module `core/fixtures/ship-life.ts`; real `isOnWatch` and
    `isOfficerOfTheWatch` built on the `helmRoleOf` stub.
14. `courseSystem` (W2) and `moodSystem` (W3) are registered as no-op stubs, so W2 need not edit
    `travel/index.ts` and W3 need not edit `needs/needs.ts`.
15. The approach.json migration test is in `packages/narrator/src/run.test.ts`; `save.test.ts`
    has its own 7→8 case.
16. Thought labels: "stood a long watch" (no stack), "double watch" (no stack), "brought the ship
    through clean" (stacks), "scraped the ship through" (stacks).
17. `captain-ashore.test.ts` "never offers work in flight" accepts captain or first officer: under
    the bill Mara is asleep when the ship docks at Kessler, so the FO goes ashore (D8).

## Stubs each stream fills

- **W1**: `core/watch-bill.ts` `generateWatchBill`; `systems/watch/helm.ts` `helmManned` (old
  staffing rule today), `whoHasTheHelm` (undefined), `helmRoleOf` ("none"), `helmPlan` (today's
  two-step plan), `runHandover` (done at once), `helmHoldDone` (today's rule), `gangwayPlan`
  (blocked), `gangwayHoldDone` (true); `systems/watch/watch.ts` helm bookkeeping (bell only so
  far); `planner/helm.ts` `helmTaskAllowed` (true), `helmTaskExempt` (false), `gangwayCandidate`
  (undefined); `travel/tasks.ts` `workerSlots` 2 for `watch`; `travel.ts` move staffing
  bookkeeping out, gate approach and docking on the helm; `steps.ts` piloting gain in the hold;
  view `SchematicView.zones()`.
- **W2**: `systems/watch/rounds.ts` `roundsPlan` (blocked); `planner/rounds.ts`
  `dutyIdleCandidate` (today's post); `travel/course.ts` `coursePlotted` (true), `courseSystem`
  (no-op), `deriveCourseToPlot` (empty), `plotCoursePlan` (blocked), `runPlot` (throws
  `NotImplementedError`); `setCourse` clears `coursePlotted`.
- **W3**: `core/thoughts.ts` `addThought` (appends; needs the non-stacking refresh), `moodOf` (no
  expiry filter yet), `moodWorkFactor` (1); `needs/mood.ts` `moodSystem` (no-op);
  `travel/hazards.ts` `hazardsSystem` (no-op; `scheduleHazard` is complete); the
  `faultsRemaining` decrement in `equipment/commands.ts`.
- **W4, W5, W6**: nothing stubbed; their sections of the plan stand.

## From slice 1's browser QA, for W1

Docking waited "for someone at the helm" while Jax (piloting 8, on duty) stood idle five tiles
from it and the captain walked in from engineering; once the wait ended with nobody at the helm.
W1's tests must include: an idle, on-watch, qualified stander takes the helm promptly, and the
helm is never left empty through a manoeuvre while a qualified hand is idle aboard.
