# Client

The renderer, the scene outside the hull, the camera, the headline, the ship's log, the labels, the
inspector and the phone layout. Code is in `apps/web/src/render/` (canvas) and `apps/web/src/ui/`
(panels); the headline is built in the sim (`packages/sim/src/core/render.ts`). The client only
reads the render frame (`RenderFrame`), the content and, for the inspector, snapshots; it never
changes the sim.

## Playback time

### The client shows only what playback has reached

The worker runs ahead of the viewer (D14), so every client surface that tells the player something
is gated on the tick playback has reached: the log, the card on screen, the inspector (a snapshot
at the view tick, never the run-ahead state), the hull bar, the clock, impact flashes. Why: anything
shown early spoils what the deck has not yet shown.

## Scene and camera

### The scene outside the hull

`sceneAt` (`render/scene.ts`) is a pure function of the travel stage, its progress, the two ports
and reduced motion, so the scenery is right on a reload, under playback interpolation and at every
speed. The render frame's travel names both ports at every stage (the dock's port at both ends
while docked) and `drifting`. The scene carries the berth offset (in deck lengths, only ever
increasing from approach to departure), sky, altitude (a planet's ground scales with it), clouds,
dust, plume, star speed and `cameraT`. Under reduced motion nothing slides: the berth fades and
stars stop. A drifting ship's stars crawl and its plume is out.

`PortDef.setting` is `station` or `planet`; it picks the palette and whether sky, cloud and dust
show.

### Orientation and the portrait turn

The bow is always east and the quay south (§orientation-and-size; `render/orientation.ts` is the one
place direction is written down). The world flows fore to aft past a ship that never moves on
screen. On a viewport taller than wide the whole drawing turns a quarter counter-clockwise, bow up,
quay to the right; text, dots and crates are drawn after the turn so they stay upright. The turn is
decided by the window, not the canvas: on a phone the canvas is nearly square and a wrapped headline
would flip the drawing.

### Stars, plume and the animation loop

Stars carry no meaning: their positions come from a fixed hash and they scroll on a client-side
accumulator at real time times `starSpeed`, so they do not go faster at 8x and stop when paused.
`DeckCanvas` runs its own animation loop and redraws only while stars or plume move or the frame,
selection or size changed, so a paused game at the dock costs nothing. Travel progress
interpolates within a stage (§frame-playback), so the berth slides smoothly between frames.

### Dock drawing

From the start of `docking` to the end of `undocking` the renderer draws the dock the frame names
(`RenderFrame.dock`); on either side, while the port is still in view (`approaching`, `departing`),
it draws the content's dock for that port (`dockInView`, `render/dock.ts`). A port without a map
keeps a stand-in berth. The dock sits at the grafted position plus the scene's berth offset, so it
slides in during `docking` and away during `undocking` and `departing`.

- People and loose items with `onDock` set, and all locals and props, move with the slide
  (`withDockSlide`); nobody aboard does. No one crosses a ramp while the dock slides.
- The look is derived from the map and its port's setting, not authored: a station gets deck plates
  and a dark bay pit; a planet berth surrounded by quay is a pad among fields hazed in the dock's
  sky colour; an open planet berth is a pier over a sea of cloud. Station quays get clamps that
  engage over the last fifth of `docking` and release over the first fifth of `undocking`.
- Structural foreground (bay walls, terminal edge, rock) stands only on non-floor tiles, so posts in
  wall gaps show, and no foreground piece is more than 0.3 opaque over the ship. The foreground is
  drawn under the dots and labels, so walls and clouds never hide a person.
- Ramps are drawn by `RenderDoor.openFraction` (a jammed door reads shut), so the picture shows how
  far a ramp really is open. Powered ramps travel open and shut in `doors.rampOpenSeconds` (2 s).
  Docked ramps stay down.
- A landing site (§site-maps) has no quay: no edge, clamps or bay walls; the berth is the same
  loose ground as the rest, pressed darker, and the fields round it take the site's sky. Cover is
  drawn by its legend character: `n` as net racks (two posts and a dark lattice), any other as the
  crates prop. A site's posts have no drawing; a tapped one gets a small marker.

### Camera

The camera frames the whole hull plus a tile in flight and ship plus dock map plus a quarter tile
docked, and interpolates each edge by `cameraT` during `docking` and `undocking`
(`render/camera.ts`; under reduced motion the slide becomes a fade but the zoom still eases).
Machine names are not drawn below 14 px a tile, so on a docked phone the room plates stay and
machine names hide. On a portrait phone the picture keeps nearly every pixel of the width: the
padding is a hairline.

## Drawing the ship

### Rooms, items and cargo

Compartments have distinct fills by kind and drawn walls. Items aboard are drawn on the deck and on
the carrier. Freight on offer (a job not yet taken) is a translucent crate with a dashed outline in
its class colour, never piled with taken freight. Pocketed items (rations) are not drawn.

### Hand truck drawing

A pushed truck is drawn as a handle and toe plate beside its pusher with up to four crates stacked
on it and a count tag (`drawCarriedItems`, `render/crates.ts`); the tag hangs below the toe plate
and the pusher's label rises clear of the handle. The frame already carries the truck as `carried`
and its crates as `container` items, so the canvas has no truck logic of its own. The headline does
not count a crate on a pushed truck as stowed.

### Locals and props

Locals are drawn from `RenderFrame.locals`, the staged props from `RenderFrame.dockProps`, and the
dock from content; none of this changes the sim.

- A local is a dot the crew's size in one of eight muted hues picked by `lookSeed % 8`
  (`render/locals.ts`), with a darker rim. Locals are never crew gold and never the passenger's pale
  fill and blue rim (a test holds every hue at least 80 RGB units from both). Why: a tap or a glance
  must not mistake a bystander for crew.
- A dock hand carting pushes a trolley drawn like the hand truck; its crates are general freight's
  colour, since the frame carries only a count.
- A prop is drawn as its item would be, muted 40% toward grey, as that many small crates on its
  tile, never with a count tag or the offer outline, so set dressing does not read as cargo or as an
  offer.

### Asteroid field, scars and alert

While a field is near or active, two hash-seeded rock layers (behind the hull and a sparser one over
it, `render/rocks.ts`) fade in, scroll with the stars and fade out as it clears; a stuck ship holds
them still. Rock positions mean nothing (D7): a hit is the impact flash, which plays once at the
moment playback first shows the impact (`render/impacts.ts`, held while paused). Hull scars
(`RenderFrame.hull.scars`) are an overlay over the floor and under the people, patched ones dimmer,
and are pickable. Hull and field rules are in `hull-and-field.md`.

### Fight drawing

Each `RenderShot` (`RenderFrame.shots`, from the tick's `shotFired`) is a tracer from shooter to
target for 200 ms and, on a hit, a flash at the target for 360 ms (`render/shots.ts`), keyed by
its tick so it plays once from the moment playback first shows it, on a real-time clock held while
paused. A tracer is sized to the dot and drawn over a dark edge, so it reads on a site's light sand
as on a dark deck (`tracerStrokes`): a hit is a thick warm line in an orange glow, a miss a
thinner, pale blue dashed line with no glow. A hit's flash is a bright core and an expanding red
ring. The other side's dots take a local's hue and darker rim, stable per person
(§locals-and-props: never crew gold); the down are dimmed toward grey and the dead more so with a
cross. A fighter's label is the combat system's (§the-combat-system-owns-its-combatants), "down"
for someone incapacitated in the fight.

The top bar carries the hull bar next to the clock, red below a third of the hull, and the whole
bar tints on alert, when the bell line reads "ALERT" (shortened below 430 px). `shipLost` replaces
the screen with an end screen: the day, where the ship was bound, the last six log lines up to the
loss (none for a save loaded already lost) and a New game button (`ui/ShipLost.tsx`).

## Headline

### The ship headline

`RenderFrame.headline` (`shipHeadline`, `core/render.ts`) is one persistent line under the top bar
saying what the ship is doing, derived from state: travel stage, destination, ETA, loading and
unloading counts, and what the ship waits for. The ticker is secondary. Why: the owner found "not
clear what's happening at the top level."

At a landing site it reads "Set down at <site>" and never "looking for work"; with a course
planned, "Set down at <site> — lifting off for <port>", naming the voyage's far end. Toward a site
the approach and docking read "Setting down at <site>", and leaving one, both undocking and
departing read "Lifting off from <site> — bound for <port>".

Docked, the first match wins: the captain ashore ("Docked at <port> — <name> is ashore looking for
work", or "... is talking with <name>"), then unloading or loading progress, then a passenger the
ship waits for, a stop on the way to a farther destination, holding for repairs, preparing to
depart (with "waiting on a course" while the course is unplotted), and last "looking for work".
While preparing to depart it names what it waits for: freight, someone ashore, the helm, the ramps.
The count of crates stowed leaves out crates in hands or on a pushed truck, and freight on the dock
is not aboard. Under way it gives the ETA at the current engine output, or limping or adrift.

The headline never narrates. Docked with no cargo work it reads "looking for work" whether or not an
offer is open; offers and every other story claim are the card's to tell. Why: the headline once
said an issuer was offering freight, a claim the narrator never made.

### The shore header

While an expedition's site is alongside (`RenderFrame.expedition`), the headline opens with one
word a side, "Us: steady · Them: breaking", in bold, tinted with the alert. Only those who fight
count: the party, and the cast's guards and allies (not the target or a bystander, who have no
morale of their own). A side is `done` when none of them can fight, else `breaking` when anyone
breaks, `shaky` when anyone wavers, and `steady` otherwise (and before anyone is in it). Once the
expedition is resolved the words drop and the line keeps only the alert's tint, since its people
are out of the fight and would read `steady` again. It snaps to the later frame like the
headline. Why: a shaky bystander made the cast read "shaky".

## Ship's log

### The log in playback order

One feed (`ui/log.ts`, `ui/Log.tsx`) holds event lines and the cards the captain was shown, newest
on top. Each entry is stamped with a sim tick, kept in tick order (stable within a tick), capped at
`LOG_LIMIT` (200) and shown only once playback reaches its tick. Why: the ticker was once fed when
the worker produced a frame, so with run-ahead it told the viewer things the deck had not shown.
The log is not saved and starts empty after a reload.

### Cards in the log

A card is logged at `decisionShownTick` (§delivered-tick), not when it was held, the tick the card
itself comes up. A card shows "waiting" until answered, and tapping it brings the card back up.
Once answered it shows the choice and expands to the full text and the aftermath. A card that
closed a story thread is marked (§closing-cards).

## Labels and plates

### Person labels

A crew member's, passenger's or labelled local's plate is their first name alone; what they are
doing is in the inspector. A local is labelled only while doing something, in a dimmer text colour.
A group session is one plate at its venue naming the game and every member's first name ("cards —
Jax, Tomas"), cut to 34 characters, and its members' own labels are left out, since one plate stands
for several people. Why: name plus action crowded the phone view. A leading title or epithet is
skipped for the word after it ("Old Pell" reads "Pell", "Sister Aurelie Doucet" "Aurelie"; the
list is in `render/sessions.ts`).

### Label placement

`placeLabels` (`render/labels.ts`) is pure geometry over measured plate sizes. Each label tries a
few spots around its dot (above, below, beside, then further up or down with a leader line) and, if
crowded everywhere, a shorter text; it never covers another person's label, avoids dots and room
plates where it can, and stays on the canvas, 2 px in from each edge; a text wider than that is cut
with an ellipsis to fit (`fitLabelText`). Order is session plates, crew, then locals, lowest on
screen first. Machine names and room plates under a placed label are left undrawn. Labels are only
drawn for dots on the canvas, so a dock sliding in has no stray labels.

## Tapping and the inspector

### What a tap selects

`pickAt` (`render/pick.ts`) tries, in order: a person, crew and locals together, the nearest within
0.8 tiles; the ship's items; staged props; machines; a hull scar; bare deck floor (its room); a dock
post or bare dock floor. So a tap on a regular at their post opens the person, not the post. A prop
has no id and is selected by its index in the frame (its position changes as the dock slides).

### Inspector sources

Content and the frame answer a post, a dock floor, a local or a prop (`ui/dockInspection.ts`), with
no snapshot. A person asks the worker for their agent view and weighing at the view tick; an item,
room, scar or machine reads the snapshot at the view tick. The host forces a snapshot at the tick a
hook or decision halts on, so tapping a crate whose offer card is waiting finds it. A tapped person
or prop that left the frame between the draw and the tap opens nothing.

### Items, places and locals

- An item is described by room, or by area or nearest post (within two tiles) when on the dock;
  freight shows issuer, route and contract status. Freight on offer says "freight on offer" and that
  nobody loads it until the job is taken. A crate on a hand truck reads "on the hand truck, pushed
  by <name>".
- A local shows name, role, "Where" ("at the queue-board kiosk" within two tiles of their post, else
  the dock area or nearest post, with their post on its own line), "Doing" when labelled and a new
  face's look line.
- A prop shows its name, "on the dock" and that it belongs to the port, not the ship. A room shows
  its dirt, who mops it and its hull scars.
- At a landing site the ground reads "the landing site", and a post's subtitle names its kind
  ("A guard post · The Boathouse, on the shingle") with a line on what the spot is for.

### The person sheet and weighing

A crew member's sheet shows activity (the full action label), watch and duty, mood word and heaviest
thoughts, the five needs, interests, relationships, known problems and the roster. Under "Weighing"
it shows what the planner is ranking (§what-a-crew-member-weighs, pure over the `AgentView`): every
option best first with its urgency class and estimated seconds, which one the person is doing and
which comes next, a one-line verdict, and a collapsed list of what was ruled out and why. It is
worded in the worker, where the names are, on the tap. Passengers have no watch or weighing
section.

### The body line

Every person's sheet has a body line from their agent view (`SelfView.body`): "unhurt",
"stunned", "wounded: right leg (serious), bleeding", "down — wounded: torso (grave), bleeding",
"dead"; marked when not "unhurt". One of a site's cast (`combatant.side` `them`) shows only name,
their role there, the body line and their state in the fight, with none of the crew's watch,
needs, weighing, problems or roster.

## Notices

### Toasts

A toast (`ui/Toast.tsx`) is a one-line notice above the bottom edge for 4 s: a rejected player
command (§decision-queue-and-halts) or an auto-slowdown (§auto-slowdown). It never covers a
decision card: a card coming up (or closing with its aftermath) dismisses it, and none is drawn
while one is up. An auto-slowdown's toast clears as soon as the player sets a speed, since it no
longer says what the game is doing. Why: a stale "Slowed to 1×" sat over the turn card and the log
lines it named.

## The phone

### Portrait layout

In portrait the chrome has fixed heights (`ui/portraitLayout.ts`, set as CSS custom properties on
`.app`): a one-row top bar, a two-line headline (the same height wrapped or not), a thin travel bar
while not docked, and a compact log under the canvas that a toggle opens out. The canvas takes the
rest, so the camera tests can check legibility against the size the app lays out. In landscape the
log is a full-height column.

## Dev tools

### Dev expedition start

In a dev build only, `?expedition=<siteId>[&plan=<planId>]` starts a fresh game (never the saved
one, so a reload replays the fight) and posts `scenarioStartExpedition` after the worker loads
(`host/devExpedition.ts`, read in `App.tsx` under `import.meta.env.DEV`); a rejected site or plan
shows as a toast. Production builds carry none of it.
