# Decision cards

Everything the captain decides on screen: what a card is, what its sides can do, how the queue
halts the world, and how cards from the port arrive in person. Code is in
`packages/sim/src/core/` (`decisions.ts`, `delivery.ts`, `command-handlers.ts`), the card text
contract in `packages/narrator/src/contract.ts` and `translate.ts`, and the modal in
`apps/web/src/ui/DecisionModal.tsx`. What the narrator writes and why is in `narrator-story.md`.

## Card shape

### Cards and sides

A `Decision` has a prompt, a left and a right `DecisionOption`, a status (`pending`, `resolved`,
`dropped`) and an origin (`policy` for kernel-raised cards, `narrator` for the rest, job offers
included). Each option is a label, the commands it runs, an optional `nextDecisionId` (the next
card, shown straight after) and an optional aftermath. The perspective actor is the captain, or
the first officer while the captain is asleep or incapacitated (D8), fixed at creation.

Choosing a side runs its commands as source `player`, so each must be a player-authority command.
All of them are validated first; if any is rejected the whole choice is rejected and the card
stays up. The client shows the prose over the template text; prose never enters sim state.

### Spoken cards

A card is brought to the captain by a named person in their own words, with a `speaker`: a
grievance by the crew member concerned, an operational matter by the first officer, an offer by
its issuer. A blank speaker is an observed scene. Side labels are what the captain says or does.
The situation is at most 70 words (target 35 to 55), a label at most 48 characters, and no card
text carries numbers.

Why: the owner reviewed a narrated "Jax and Priya's Argument" card and wanted it spoken, Reigns
style, so a face can be shown later.

### The captain never speaks

The crew member tagged `captain` is the player's avatar and never a card speaker. The translator
turns a captain speaker into an observed scene (the card survives) and feeds the reason back to
the narrator as a correction. The captain keeps a voice for how they come across, shown to the
narrator only.

### Cards never mention pay

Offer cards describe the job and the person offering it; money appears only in the top bar. An
issuer's pitch is one line of dialogue, 30 words at most. Why: "pay hints are not that
interesting."

## Sides and effects

### Side effects

A narrator card side carries an `effect`, which the translator turns into the side's commands (or
drops the whole card if it cannot):

- `none`: no commands. A beat card's sides are the captain's attitude and are both `none`.
- `setCourse` (`coursePort`): the `setCourse` command. Only while docked, to a known port other
  than this one with a route from here.
- `endPassage`: see below.
- `privateTalk` (`talkWith`, `tone`): see below.

### End passage effect

`endPassage { jobId }` ends the live passage with no fare: the passenger is put off at the next
docking (at once, if docked), `endReason` `putOff`. It is a real side only while a passenger is
aboard or ashore on an unended passage. The passage itself is in `commerce.md`.

### Private talk effect

`privateTalk` is a card side effect the player chooses and a player-authority command. It calls
the named crew member to the command actor's cabin for a word, `warm` or `stern`; the talk
itself, its refusals and its effect on affinity are in `social.md`. The translator offers the side
only for crew aboard who are not the captain, a passenger, ashore or on the dock, and only when
no talk is pending.

## Aftermath

### Aftermath caption

Every side can carry a one-line caption, shown for a moment (`AFTERMATH_MS`, 2.5 s) after the
choice and before the card closes, saying plainly what happens next. At most 20 words, no
numbers. The caption is the narrator's prose when it wrote one, else the option's own `aftermath`
(`apps/web/src/ui/aftermath.ts`), else a built-in line for job offers, else a generic one. A
blank narrator caption means none, not a reason to drop the card.

Why: the owner declined a job and "it really wasn't sure what was going to happen next."

## The queue

### Decision queue and halts

`decisions.queue` is FIFO: the head is the card on screen, and every reader of the queue means
"on screen now". The world halts (`haltReason`) while the queue is non-empty, unless the head's
`resolveDecision` is already queued for the next tick; a pending hook outranks a decision.
`resolveDecision` is accepted only for the head. A card whose chosen side names a
`nextDecisionId` puts that card at the head.

A rejected player command raises a toast with the kernel's reason, friendlier for the common
cases (`apps/web/src/ui/rejectionMessage.ts`), never a silent failure.

### Policy decision cards

A kernel-raised decision goes through `queuePolicyDecision` (the departure gate, a passenger
overdue). When it reaches the head of the queue, phase 8 raises a `policyDecision` hook for it
(`decisionPendingSystem`), and the world does not halt on the card until that hook has been
raised, so the host sees the hook halt first, calls the narrator, and has the prose keyed by
decision id before the modal opens. The template text is the fallback when the narrator fails or
is offline. A policy card is brought by crew (the engineer for the gate, the first officer for a
missing passenger) and is never held for delivery in person. Hook raising and spacing are in
`narrator-calls.md`.

Why: "anything that requires a decision gets narrated." Job offers are not hooked: the offer card
already carries the issuer's pitch.

### Offer cards

An offer made on the dock surfaces as a card whose sides take or pass the job. Offers are only
made in person at the dock: `offerJob` with `surface: true` is refused unless docked at its
origin, and the translator drops an offer in flight. A quiet offer may be posted anywhere, for
scenarios. The card has a record until its job closes; see "Stale held cards" for what happens to
one that closes while it waits.

## Cards in person

### Holding a card

While docked at a port whose dock is alongside, a card whose speaker is one of the port's people
(an offer's issuer, or a narrator card's `speaker` who is not the name of any crew member or
passenger, wherever they are) is held: its record is `pending` but it sits in `decisions.held`
(`HeldCard`: speaker, port, `heldTick`), not the queue, so nothing halts on it (`queueOrHold`,
used by `surfaceDecision` and `surfaceOfferCard`). The speaker must be reachable: standing on the
dock or with a gate to the port beyond. `cardHeld` is a trace event.

Crew and passengers bring their cards at once, and so do observed scenes, policy cards, anything
in flight, and docks with neither the speaker nor a gate.

Why: a flag on queued cards would let a reader that missed it halt on an invisible card.

### Delivery

A held card comes onto the queue (`deliverHeldCard`, event `cardDelivered` with a reason) one at a
time, oldest first, when the captain and the speaker meet. How is decided when the meeting
starts, from where the walker is (whoever went ashore this docking, else the command actor):

- On the dock, out through the gate or on the way: the captain goes. For a local on the dock they
  walk up beside them and `talk` for `travel.talkSeconds` (3); for anyone else they go out
  through the gate for `travel.gateVisitSeconds` (4) and the card comes up on the way back in.
- Aboard: the speaker comes. A local on the dock walks to the foot of the personnel ramp, or
  someone from the port walks in from the gate as a `visitor` local; the card comes up when they
  arrive, then a visitor leaves and a local returns to their post.

The hand-out is re-handed until it starts, gives way to essential operation or above and to the
call aboard, and overrides routine work. An interrupted walker stops; the walk is handed out again
on the next free tick, to the first officer if the captain is no longer fit. The captain out
through the gate is still fit for command (`isFitForCommand`, `core/command-actor.ts`), so
going ashore never moves the card's perspective. The captain's own walk is in `dockside.md`.
Meetings are plain state, so a save mid-walk resumes.

### Delivered tick

`Decision.deliveredTick` is the tick a held card came onto the queue. The client shows the card
and logs it from `decisionShownTick` (`deliveredTick`, else `createdTick`), so with the worker
running ahead a card never covers a captain still walking down the ramp. A held offer's
`jobOffered` is a trace event; the card is its first word in the log.

### Give-up and leaving

A card held `travel.cardDeliveryGiveUpSeconds` (45 s) comes up anyway (reason `gaveUp`), and one
whose port the ship is no longer docked at comes up at once (`leaving`).

### Stale held cards

A held offer card whose job is no longer `offered` when it would be delivered is dropped
(`decisionDropped`, status `dropped`) instead of queued, since neither side could be answered and
the world would halt on it for good. The same check covers a missing record or a card already
answered. The server's card history forgets a dropped card that never came up.

### Departure while a card is held

Departure from the dock waits while a card is held (the travel departure gate and `setCourse`),
and so does a voyage at a waypoint. A card the ship leaves behind is therefore not possible.
