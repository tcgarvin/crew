# Ship

The hull contract every deck meets, the ships in the content bundle, and where crew sleep and keep
their belongings. Code: `packages/content/src/schemas/validate-hull.ts`, `validate-dock.ts`,
`geometry.ts`; `packages/sim/src/core/berths.ts`, `docks.ts`; `packages/sim/src/systems/cabins`.
The deck JSON itself (`packages/content/data/decks/`) is the layout; this file does not restate it.

## The hull contract

### Orientation and size

Orientation is an invariant, not a parameter: the bow is east and the quay is south. The validator
(L3, every deck) requires that the deck fits its `hull.sizeClass` box (S 24x14, M 36x20, L 40x24),
that a `bridge` compartment touches the east edge (x = width - 1), and that both ramp doors face
`s` from the bottom row with their transfer tiles on or beside them. `hull` carries no ramp slots:
the ramp doors already say where the ramps are. The sim has no direction; it lives only in the
renderer (`render/orientation.ts`, `FORE = +1`).

Why: the owner ruled bow east. One fixed orientation lets dock maps, the camera and the phone
layout assume it.

### What a deck must offer

L3 requires the rooms, stations, zones and spawns ship life needs:

- compartments tagged `bridge`, `quarters` (or a `cabin`), `mess`, `galley`, `engineering`,
  `cargoHold` and `airlock`;
- exactly one `pilotStation` and one `navStation`, and at least one `engine`, `messTable` and
  `stove`; the pilot station has a `use` position apart from its seat, the standby tile where the
  oncoming watch waits;
- a `cargoStowage` zone, and a `crew` and a `passenger` spawn point;
- the galley loop's `pantry`, `serving` and `cleaningLocker` zones, a `serving` tile beside a
  stove's `use` position, and mess tables seating at least four;
- every `locker` zone serving exactly one bed by `machineKey`, and no bed with two lockers.

Per scenario: a `crew` spawn point for each crew member, beds for crew + 1 (`bed`-tagged, never
the infirmary's `medBed`), and a ship whose class fits every dock's berth box. Each failure is its
own validation issue.

### Scenario tools

Validation (L3) requires every scenario to carry, among its starting items, a tool of every kind
that a repair or inspection recipe on its deck names. Markets may still sell tools, as
replacements. Why: a tool only a far port sells leaves every fault needing it unrepairable
everywhere else (the welder the ship never carried). The default scenario stows a welder torch in
the hold beside the toolkits. The sim's side of a lost tool is in `equipment.md`.

## Berths on the dock map

### Berth boxes

A dock map does not draw the ship. It declares `berth: { origin, sizeClass }`: the box must lie on
the map and be all `void`, the quay row under it must be walkable floor across its full width, and
every deck whose class fits the box must land both ramps on floor that reaches every post and area.

### Ship placement

The ship's place in a box is derived by one rule, `berthPlacement` (`sim/src/core/docks.ts`):
flush to the south edge, centred, an odd spare column going east. Content mirrors it as
`shipAtInBerth` (content may import only sim types); a CLI test holds the two equal for every dock
and deck. Dock posts follow the bow (gate, kiosk and benches by the personnel ramp, warehouse and
bays by the cargo ramp), except at Tern's Rest, where the long walk to the far end of the pier is
the point.

## The ships

### Freighter Mk2

`deck.freighter_mk2` (36x20, class M) is the default ship and the scenario's deck. Every room is
furnished: bridge, captain's, first officer's and two-berth passenger cabins, an eight-bunk
bunkroom, lounge, mess, galley, stores, gym, infirmary, airlock and hold. Several furnishings are
inert content with no behaviour of their own (ops terminal, desk, games table, vid screen,
exercise rig, workbench); the terminals draw 0.2 kW of domestic power. The galley stove is tagged
`stove`, the helm `helm`, and the infirmary bed `medBed`, so nobody sleeps in it.

### Freighter Mk1

`deck.freighter_mk1` (32x18, class M) has no scenario. It stays loadable so berth boxes and the
hull contract are exercised against two footprints.

## Berths and lockers

### Berth assignment

`assignBerths` (`sim/src/core/berths.ts`) is a standing rule: it runs at world creation and every
tick in the needs stage. Everyone aboard gets the first free bed for their rank, in rank then actor
id order: a passenger a bed in a `passengerCabin`, the captain `captainsCabin`, the first officer
`officersCabin`, anyone else `quarters` (the bunkroom). Failing that, any free bed outside the
passenger cabin; failing that, unberthed. A bed is a placement whose machine carries `bed` and not
`medBed`, tried in deck placement order.

The dead, anyone removed from the ship, and a passenger left behind free their berth. Someone
briefly ashore (`offShip`) keeps theirs. State holds the berth as the bed's placement key
(`WorldState.berths`).

An unberthed crew member serving aboard holds the `noBunkOfMyOwn` thought; the cabins system checks
every `cabins.checkEverySeconds` (60). See `crew-life.md` for the cabin thoughts.

### Sleeping in a berth

People sleep in their own berth or a bed nobody is assigned, never in another's: the planner reads
`AgentView.assignedBeds()` and the sleep plan refuses one as a second guard. There is no
hot-bunking. A sleeper in a cabin is labelled by the cabin ("asleep in the captain's cabin"),
since content has no pronouns.

### Lockers

A locker is the zone whose `machineKey` names the bed. At world creation each crew member's
`personal` starting items (the harmonica, the old photograph) leave their hands for the first tile
of their berth's locker with `ownerId` set; with no locker or no berth they keep them
(`stowPersonalItems`). `lockerTileOf` finds the tile where an owned item is put back after use.
