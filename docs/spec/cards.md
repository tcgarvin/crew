# Decision cards

Everything the captain decides on screen: what a card is, what its sides can do, how the queue
halts the world, and how cards from the port arrive in person. Code is in
`packages/sim/src/core/` (`decisions.ts`, `delivery.ts`, `decision-handlers.ts`), the card text
contract in `packages/narrator/src/contract.ts` and `translate.ts`, and the modal in
`apps/web/src/ui/DecisionModal.tsx`. What the narrator writes and why is in `narrator-story.md`.

## Card shape

### Cards and sides

A `Decision` has a prompt, a left and a right `DecisionOption`, a status (`pending`, `resolved`,
`dropped`) and an origin (`policy` for kernel-raised cards, `narrator` for the rest, job offers
included). Each option is a label, the commands it runs, an optional `nextDecisionId` (the next
card, shown straight after, §follow-up-cards), an optional aftermath, and for a tried side an
`attempt` (§tried-sides). The perspective actor is the captain, or the first officer while the
captain is asleep or incapacitated (D8), fixed at creation.

Choosing a side runs its commands as source `player`, so each must be a player-authority command.
All of them are validated first; if any is rejected the whole choice is rejected and the card
stays up. The client shows the prose over the template text; prose never enters sim state.

### Spoken cards

A card is brought to the captain by a named person in their own words, with a `speaker`: a
grievance by the crew member concerned, an operational matter by the first officer, an offer by
its issuer; never the captain (§captain-never-speaks). A blank speaker is an observed scene. Side
labels are what the captain says or does. No card text carries numbers; length caps are
§player-facing-text-checks.

Why: the owner reviewed a narrated "Jax and Priya's Argument" card and wanted it spoken, Reigns
style, so a face can be shown later.

### Cards never mention pay

Offer cards describe the job and the person offering it, in the issuer's one-line pitch; money
appears only in the top bar and the ship's log. Why: "pay hints are not that interesting."

## Sides and effects

### Side effects

A narrator card side carries an `effect`, which the translator turns into the side's commands (or
drops the whole card if it cannot):

- `none`: no commands. A beat card's sides are the captain's attitude and are both `none`.
- `setCourse` (`coursePort`): the `setCourse` command. Only while docked, to a known port other
  than this one with a route from here.
- `endPassage`: see below.
- `privateTalk` (`talkWith`, `tone`): see below.

A tried side's `failEffect` is one of the same four, with the side's own `coursePort`, `talkWith`
and `tone`; it runs instead of `effect` when the roll fails (§tried-sides).

### End passage effect

`endPassage { jobId }` puts the passenger off with no fare (`putOff`, §ending-a-passage-early). It
is a real side only while a passenger is aboard or ashore on an unended passage. On an errand's
captive it fails the errand too (§settling-the-errand), and the voyage home is kept.

### Private talk effect

`privateTalk` calls the named crew member to the command actor's cabin for a word, `warm` or
`stern` (§private-talk). The translator offers the side only for crew aboard who are not the
captain, a passenger, ashore or on the dock, and only when no talk is pending.

### Follow-up cards

A card side may carry a `next` card (`DecisionCardSide.next`), and a tried side a `failNext`: the
second panel of a scene, shown straight after its branch is taken. `surfaceDecision` mints each as
its own `pending` record, neither queued nor held (only its branch brings it up), framed from its
own perspective if it names one, else the card's, and links it as the option's `nextDecisionId`
or `attempt.failNextDecisionId`. Every side and lever on it is checked when the card goes up, and
again when its own side is chosen. `resolveDecision` puts the follow-up of the branch taken at the
head of the queue and drops every other follow-up the card carried (`decisionDropped`, status
`dropped`, after `decisionResolved`), so no pending record is left that nothing can reach; a held
card dropped as stale takes its follow-ups with it. A follow-up card has no follow-ups of its own
(the kernel refuses one, and the plan schema has none) and carries no job.

The narrator writes them as `surfaceDecision.followUps`, each `{ on, card }`: `on` is `left`,
`right`, `either` (the same card after both; the kernel mints one per side and drops the unused
one) or `failed` (after each tried side's failure); `card` is a card without thread fields or
follow-ups, with plain sides (no odds). At most one per place. Its text is held to the same checks
as the card's, its speaker may differ (the guard who answers the bluff), and the whole scene is the
call's one card (§one-card-per-call). Why: narrator arcs §7.2; the design's recommendation, adopted
by the owner, that a follow-up counts as the call's card and has none of its own.

### Tried sides

A side with an `attempt { odds, failCommands, failLevers, failAftermath?, failNext? }` is a try:
the narrator's honest chance, a whole percent from 0 to 100 with no clamp (narrator arcs §8.4),
that the captain's choice comes off. When it is chosen `resolveDecision` rolls once,
`rng.chance("narrator", odds / 100)` on the seeded `narrator` stream, writes `Decision.tried
{ odds, worked }` and emits `attemptRolled { decisionId, side, odds, worked }` (`notable`, not
hooked, no ticker line: the aftermath and the follow-up are the reaction). Worked, the side runs as
any: its `commands`, `aftermath` and `nextDecisionId`. Failed, its failure branch runs instead:
`failCommands` as `player`, then `failLevers` as `narrator`, then `failAftermath` and
`failNextDecisionId`. Choosing the other side rolls nothing.

Both branches' player commands are validated before the roll, as one side's are, so a stale one
refuses the choice and the card stays up. The failure levers are outcome levers only
(`FAIL_LEVER_KINDS`: `strike`, `transact`, `plantMemory`, `fallOut`, `giveThought`, `reveal`,
`injectFault`), allowed only on a card the narrator or a scenario surfaced, minted at translation
and checked against the state when the card goes up; on failure each is checked again and applied,
or refused alone with `failLeverRefused { decisionId, kind, reason }` (`notable`) when it is no
longer possible, so the captain's choice is never undone by one. Because they run as `narrator`,
`AUTHORITY.player` is unchanged. Why: narrator arcs §8.1-§8.3, D106; "the narrator loads the dice;
the sim throws them".

The narrator sets it on `surfaceDecision`'s sides (§card-lever): `odds` ("" for no try, else a
whole percent as a string), `failEffect`, `failLevers` (the indexes in the plan's `intents` of the
outcome-lever intents that belong to the failure branch; the translator takes them out of the
plan's own commands, whatever their order) and the card's `leftFailAftermath` and
`rightFailAftermath`. The translator refuses odds that are not a whole percent, a failure branch
written without odds, odds on a beat or closing card (those sides are the captain's attitude), a
`failLevers` index that names no outcome lever in the plan or a lever that was itself dropped, and
a try whose branches are identical (same commands, no lever, no failure aftermath of its own, no
follow-up on either branch). A lever on a card that does not go up is reported dropped. A lever on
a failure branch serves the card's beat (§beat-attribution), not its own. The card shows no number:
a stated chance is the speaker's to voice (§player-facing-text-checks).

## Aftermath

### Aftermath caption

Every side can carry a one-line caption, shown for a moment (`AFTERMATH_MS`, 2.5 s) after the choice
and before the card closes, saying plainly what happens next (caps: §player-facing-text-checks). The
caption is the narrator's prose when it wrote one, else the option's own `aftermath`
(`apps/web/src/ui/aftermath.ts`), else a built-in line for job offers, else a generic one. A blank
narrator caption means none, not a reason to drop the card. A tried side's caption is the branch
the roll took (§tried-sides): the card stays up without a caption until the worker's
`attemptRolled` arrives, then shows the side's `aftermath` if it worked or its `failAftermath`
("It does not come off." when it has none) if not, and the timer starts from then; a refused
choice closes it.

Why: the owner declined a job and "it really wasn't sure what was going to happen next."

## The queue

### Decision queue and halts

`decisions.queue` is FIFO: the head is the card on screen, and every reader of the queue means
"on screen now". The world halts (`haltReason`) while the queue is non-empty, unless the head's
`resolveDecision` is already queued for the next tick; a pending hook outranks a decision.
`resolveDecision` is accepted only for the head. A card whose chosen side names a
`nextDecisionId` (or, for a failed try, `failNextDecisionId`) puts that card at the head
(§follow-up-cards).

A rejected player command raises a toast with the kernel's reason, friendlier for the common
cases (`apps/web/src/ui/rejectionMessage.ts`), never a silent failure.

### Policy decision cards

A kernel-raised decision goes through `queuePolicyDecision` (the departure gate, a passenger
overdue, an expedition's arrival and turn cards, §the-arrival-card, §the-turn-card). When it
reaches the head of the queue, phase 8 (`decisionPendingSystem`) raises a `policyDecision` hook
for it, and the world does not halt on the card until it has, so the prose is ready before the
modal opens (§policy-decision-hook). A policy card is brought by crew (the engineer for the gate,
the first officer for a missing passenger and for the arrival card, the first officer or a
standing member of the party for the turn card, never the captain) and is never held for delivery
in person. The narrator's answer only dresses it, except for one mark: on the arrival card it may
name a side as the way in unseen (§unseen-lever), which changes the fight that side starts and
nothing on the card.

### Offer cards

An offer made on the dock surfaces as a card whose sides take or pass the job (§offer-card); only
an offer made in person at the dock surfaces (§offer-command-and-price-bands). The card has a
record until its job closes; one that closes while held is §stale-held-cards.

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
time, oldest first, when the captain and the speaker meet. Who walks is decided when the meeting
starts, from where the walker is (whoever went ashore this docking, else the command actor): on
the dock, out through the gate or on the way, the captain goes to the speaker; aboard, the speaker
comes to the ship. The walks and their hand-out are §meetings-and-visitors and §looking-for-work;
going ashore never moves the card's perspective.

### Delivered tick

`Decision.deliveredTick` is the tick a held card came onto the queue. The client shows the card
and logs it from `decisionShownTick` (`deliveredTick`, else `createdTick`), so with the worker
running ahead a card never covers a captain still walking down the ramp. A held offer's
`jobOffered` is a trace event; the card is its first word in the log.

### Give-up and leaving

A card held `travel.cardDeliveryGiveUpSeconds` (45 s) comes up anyway (reason `gaveUp`), and one
whose port the ship is no longer docked at comes up at once (`leaving`), and one with no way to
meet comes up as `noWayToMeet`.

### Stale held cards

A held offer card whose job is no longer `offered` when it would be delivered is dropped
(`decisionDropped`, status `dropped`) instead of queued, since neither side could be answered and
the world would halt on it for good. The same check covers a missing record or a card already
answered. The card history forgets it (§card-history).

### Departure while a card is held

Departure from the dock waits while a card is held (the travel departure gate and `setCourse`),
and so does a voyage at a waypoint. A card the ship leaves behind is therefore not possible.
