# Time and watches

The ship's day and how it is counted, how play speed relates to it, the watch bill, the bell, and
the helm as the duty station. Config is in `packages/content/data/config/default.json`
(`time`, `watches`, `hazards`, `host`); code in `packages/sim/src/core/clock.ts`,
`packages/sim/src/systems/watch/` and `apps/web/src/host/slowdown.ts`.

## Time and play speed

### Time is a playability knob

Time is a gameplay knob, not a fictional ratio. Docking takes a few seconds, a short hop up to
about 30 s, a long hop longer and expected to carry events; needs are tuned to a 10-30 minute
session. No mapping from sim seconds to fictional time is defined, and none has to be consistent
(D10).

### The ship's day

`time.daySeconds` (1200) and `time.watchesPerDay` (3) are the two knobs. Need rates are authored
per day; meal and sleep length, offer lifetime, re-offer cooldown, passenger time ashore and
overdue, the quiet window and the budget refill are authored in days (`Days`). They are converted
where read, by `core/clock.ts` (`daysToSeconds`, `dayTicks`, `perDayToPerSecond`, `watchTicks`,
`watchIndexAt`, `watchOfDay`), never at load. Why: the config is embedded in every save as
authored, so changing the day rescales the routine without touching saves.

Motion, doors, docking stages, dockside timings, work at a machine, machine defs, host real time
and `narrator.maxFaultWindowSeconds` stay in seconds, so a shorter day compresses the routine
while walking keeps its speed. The three spur legs take one watch at nominal speed, so a handover
can happen at sea.

The top bar clock reads "Day 2 · White watch" (`apps/web/src/ui/clock.ts`), the section named for
the watch; a watch of the day with no section reads "Watch 3". Narrow phones drop the word
"watch". The bell line reads "ALERT" while the ship is on alert.

### Play speed

Speeds are 1x, 2x, 4x and 8x. The tuning target is 2x for the quiet stretch, with auto-slowdown to
1x for set pieces and 4x and 8x as skip speeds. This is a recommendation, not a ruling; if 4x
became the target, `host.runAheadCapSeconds` (60) would need raising to about 100. Why: at 4x and
above the narrator's run-ahead is shorter in wall time than its call latency, so every call
freezes the ship; at 2x a ticker line arrives every 5 s, readable.

### Auto-slowdown

Fast-forward drops to 1x when playback (not the run-ahead sim) reaches an event on
`host.slowDownOnEvents`, naming it with the ticker's own text in a toast and a highlighted log
line (cleared after 8 s or at the next slowdown). Nothing happens at 1x or while paused. The list
is for news the player should stop for: hazards, an empty helm, drifting, limping, a filthy room,
an argument, and the field events (§field-hooks). Good news on a listed type (the
engines coming back) does not slow, and nothing slows the game again within
`SLOWDOWN_COOLDOWN_SECONDS` (120) of view time after a slowdown, so a fault and the drift it
causes are one stop. Cards pause the game on their own and are not on the list.

## The watch bill

### Sections and dayworkers

The scenario authors a watch bill: section `i` stands watch `i` of the day, and dayworkers (no
section) are on duty during `watches.dayworkerOnWatches` ([0, 1]). A scenario without a bill
(fixtures) gets a greedy generated one (`core/watch-bill.ts`). Passengers are not on the bill. The
validator requires one section per watch, each with a member meeting the helm's `operatorSkill`,
a non-officer in every section, and a bill authored for any scenario of more than three crew.

### Duty and the sleep watch

On duty is derived from the tick (`systems/watch/duty.ts`), never stored. Off-duty crew take only
containment-or-above work, except cargo in port: `cargoToLoad` and `cargoToUnload` are all hands
awake, and sleepers sleep on. Sleep is anchored to the bill (`sleepWatchOf`): the watch after
one's own, so each section turns in at the same bell every day; see `§sleep-timing`.

### The bell

The `bell` event fires when the watch changes, naming the section that has it, and shows in the
ticker. The `watch` system runs each tick in the `needs` phase (`systems/watch/watch.ts`).

## The helm

### Who has the helm

Having the helm is physical: the crew member in a staff hold on its seat (`whoHasTheHelm`).
Standing beside the console is not having it. Who should have it is the sim's call (`helmRoleOf`,
`systems/watch/helm.ts`); the planner reads only the role, and helm posts and the course plot skip
`deferTo` and the off-duty rule. The stander is, in order: the section on watch's qualified
non-officer (highest piloting first), its qualified officer, the nearest qualified hand aboard,
then anyone with piloting 1 or more (visible to the narrator as an unqualified hand). While the
helm is empty a candidate must also be free to come, so an idle qualified hand is designated over a
busy or sleeping stander. Someone walking to an empty helm stays designated until they sit or drop
it; a better-placed hand who frees up relieves them by handover rather than walking up as well.
Piloting is learned only at the helm.

### Handover

`watches.handoverLeadSeconds` (30) before the bell the oncoming stander goes to the standby tile,
counts `watches.handoverSeconds` (5) while the seat is held, the off-going steps off and the
oncoming sits. An empty helm is simply taken. Someone already in the seat who changes posts does
so without a handover.

### Relief

A stander with any need past `urgency.needEssentialAbove` raises a routine `relief` post that an
off-watch qualified hand fills until the stander is back; a stander relieved to eat goes and eats.
No relief is raised within the handover lead plus `watches.reliefNoShowSeconds` (45) of the bell:
the oncoming relieves. The post resolves once a watch-post stander is back, after
`watches.reliefMaxDays` (0.1), or when the helm watch ends. Why: the bell pulls people, not the
moment's state; relief near it only churns.

### Helm vacancy

The helm watch is wanted while underway, and in port once a course is planned and plotted with
nobody ashore to wait for. Vacancy gates departure prep, the end of transit, the approach and
docking, and nothing else. After `watches.helmUnattendedSeconds` (20) empty in transit
`helmUnattended` fires once per vacancy; it is on the slowdown list. Holding the seat past
`watches.longWatchFactor` (1.25) watches gives `stoodLongWatch`, at two `doubleWatch`.

### Gangway watch and rounds

In port, until the course is plotted, the on-watch section's non-officer stands gangway watch at
the airlock (the helm's stander when that is one, else its best pilot); it needs no piloting. The
helm's post opens at the plot, so the stander's walk from the gangway shows when the plot ends
within a walk of the last crate.

The officer of the watch walks rounds (engineering, the hold, the mess, the helm's standby tile),
`watches.roundsStopSeconds` (4) at each stop, with start-to-start cadence `watches.roundsEveryDays`
(0.08), and idles at the captain's chair, never pinned. Idle on-duty engineers walk the engineering
machines. Rounds notice nothing themselves: perception does (`systems/watch/rounds.ts`).

## Piloting checks

### Hazard roll

A hazard fires on its leg as §debris-fields-and-ion-storms places it. The stander's piloting is
rolled against its tier's difficulty (`hazards.difficulty`: easy 3, hard 5, brutal 7): clean with
p = clamp((skill - difficulty + 5) / 10, 0.05, 0.95), else evenly a scrape (one weighted fault on a
ship machine through the single fault path, D6) or a delay (the leg set back
`hazards.delaySeconds`, 60, at nominal speed, never past its start). An empty helm is a scrape and
a delay, unrolled. The stander gets `helmCleanPass` or `helmScrape`; a delay gives none.
