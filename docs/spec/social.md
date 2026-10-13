# Social life

Off-watch recreation and group sessions, interests, derived affinity, and the private talk. Config
is `config.recreation`, `config.social` and `config.cabins` in
`packages/content/data/config/default.json`; activities are `packages/content/data/activities/`;
code in `packages/sim/src/systems/` (`recreation`, `social`, `cabins`) and `planner/recreation.ts`.

## Recreation and activities

### Activities and interests

Recreation is a fifth need (see `crew-life.md`), met by activities from the content table: each
`ActivityDef` names its venue, participants (min, max), duration, what it restores, its outcome,
thoughts, memories, skill gain, risk, dirt, a required item and a product. The files are the
catalogue. Everyone has interests (likes, one strong like, dislikes) and three value axes: authored
for the nine, drawn for anyone else from keyed draws on their id, so no existing stream moves.

A venue is an ordered list of alternatives, the first with a free spot winning: a machine tag (a
`use` position, `own` for one in the actor's berth compartment), a zone tag (a free zone tile), a
compartment tag (a free floor tile), or a dock post kind (`dockPost`: `marketStall`, `loungeDoor`
or `bench`, a spot by that post ashore, §shore-leave).

Content validation is per deck: a venue the deck has seats `participants.max` (at most four, one
plate); a non-contest group activity says how it is done alone; `{ref}` appears only in labels of
thoughts that carry a `refId`. A deck no scenario sails gets notes, not failures. Dock-post
alternatives are not the deck's: an activity with only those is checked against no deck, and a dock
without a post of the kind has no venue for it.

### Choosing recreation

The planner offers one recreation candidate per person, the best-scored activity
(`planner/recreation.ts`). Off duty it needs recreation above `recreation.joinAbove` (0.25), and
only joining an open session below `needs.seekThreshold`; on duty it needs the need above the seek
threshold and is `voluntaryActivity`, so any task wins but an idle cook bakes or plays. Off duty it
is `routineObligation`. Why: off watch everyone is in a voluntary rest or chat hold, which a
voluntary candidate never interrupts, so voluntary joins never filled a table.

Score: interest 3 (strong like), 2, 1, 0 (a dislike is never chosen); +2 to join an open session
with room; +1 to host a group activity; +2 for a game ashore (§shore-leave); +0.5 for a session
holding someone liked, never a session holding someone at or below `social.avoidBelow`; +1 for
group play in good mood, solo only in low mood. Joining needs score >= 1, hosting a like (or a
neutral interest ashore), solo play >= 1. Ties go to join over host over solo,
then nearer, then the bigger table. Rest and chat take `needUrgency`, and one taken because the
need pressed ends when the need is met. Why: otherwise routine games beat voluntary chat every
time and helm standers came on watch lonely.

### Group sessions

A session is common knowledge (`AgentView.sessions()`) at a venue; one game of a kind runs at a
time. A host opens it, whoever is there joins (not past `recreation.lateJoinSeconds` (20) of
running). It starts at max members or after `recreation.gatherSeconds` (45) with min; with fewer
it collapses to the solo variant and the host backs off that activity
`recreation.collapseBackoffDays` (0.1) and has `nobodyJoinedIn`. A contest or debate falling under
min is abandoned. A leaver, whatever takes them off, leaves the session that tick; a host who
leaves hands it on.
Outcomes resolve once through `resolveOutcome` and the row is deleted; a solo play resolves through
a one-member row never stored and still says `sessionEnded`. Restoration is proportional, so an
interrupted game restores in part, and waiting restores nothing (`recreation/needs.ts`).

Personal items are fetched and put back: an owned instrument from its locker, a book from the
shelf to the player's desk (the lounge without a cabin).

### Shore leave

Docked at a port, off-watch crew sometimes go down the ramp for a drink ashore
(`activity.shore_leave`, "having a drink": interest `gossip`, one to three people, 0.08 days,
recreation 0.4 and social 0.3, a `bond`). Its venues are the dock's market stall, else its lounge
door, else its bench (`core/shore-leave.ts`). A dock-post venue counts only while:

- the ship lies `docked` at a port whose dock is alongside, its ramps down at least
  `recreation.shoreLeaveMinDockedSeconds` (20, from `TravelState.dockedSinceTick`; a docking
  nobody counted, such as a game that starts docked, is long since), a course set or not: never at
  a landing site, in departure prep or under way (`shoreLeaveDock`);
- the ship is not merely waiting to cast off: the planner starts no new leave, hosting or joining,
  once a course is set and plotted (`ShoreView.coursePlotted`) and no cargo work is open
  (`cargoOpen`). Why: a course is set minutes before the ship can go, and plotted soon after; the
  hands waiting on the cargo and the plot have the time, but with both done a new leave only holds
  the ship;
- the person is crew, off duty, not the gangway stander, not a passenger and not the captain (whose
  walk ashore is their own, §looking-for-work);
- fewer than `recreation.ashoreMax` (3) others are ashore on leave: at a `recreate` step standing on
  the dock, or with a walk onto it still ahead in a `recreate` plan (`isOnShoreLeave`). The planner
  reads that count and the posts from `AgentView.shore()` (common knowledge: everyone sees who goes
  down the ramp); the `recreate` plan checks it again against truth.

A drink ashore is worth +2 over the same game aboard, and anyone not put off by gossip may host one
(a neutral interest, not only a like). A session ashore starts after `recreation.ashoreGatherSeconds`
(15), not `gatherSeconds`. Why: without these the drink tied gossip in the lounge and lost on
distance, nobody but a gossip-lover ever went, and a stop of a minute or two was over before the
gather was.

A spot by a post is dock floor within two tiles of the tile the post faces, never the post's tile or
any post's counter tile (the local's and the buyers'), a freight area, or a tile beside the berth
box (the ramp landings). A session ashore names its dock and post (`SessionVenue` `dockId`,
`postKey`); it has no room, so a performance or debate has no audience and nothing is dirtied or
set down there. The ticker says "Jax Okonkwo and Priya Kessler are having a drink ashore, by the
night-market stall", the plate is drawn by the post, and the digest's off-watch line says where
(§ship-life-lines). Once done, rest or chat (whose venues are aboard) walks them back up the ramp.
Departure prep's call aboard (§calling-the-crew-aboard) ends a drink like any other interruption,
and an invariant holds a session ashore to its dock alongside. Why: texture, the crew living at the
port and not only aboard; the cap keeps the ship crewed.

### Outcomes

`systems/social/outcomes.ts`, by the activity's outcome kind:

- **Contest**: a winner drawn weighted by interest. Everyone remembers the table (`together`) and
  the loser remembers the winner (`loserToWinner`); cards and board games net zero per game
  (`goodTime` +1, `beatMe` -1).
- **Debate**: each member's stance comes from their values against the topic's weights. A pair
  within `social.debate.agreeWithin` (2) has a spirited talk (`goodTalk`); at `argueBeyond` (4)
  or more they argue (`argued`, one `argument` event per session). Non-members in the room who
  dislike debate are lectured.
- **Performance**: awake people in the room like it or not by interest; likers remember
  `playedForMe`.
- **Bond**: members who like the activity warm to each other. A bond with topics (a vid, gossip)
  has one picked at the start, which the digest names; it moves nothing.
- All: skill gain, dirt, risk (a sparring knock is a thought and a line), and a product. Baking
  puts treats on the counter tagged `treat`, never `meal`, so a treat never answers the mess call
  (§eating), and gives the baker `bakedForTheCrew`.

### Rivalries

Wins and losses per pair per activity are tallied. A run of `social.rivalry.streakFor` (2) losses
gives the loser `keepsBeatingMe` (thought and memory) on each further loss, and one
`rivalryStreak` ticker line per run.

## Relationships

### Affinity

Nothing stores affinity. What `from` feels about `to` (`affinityOf`, `core/social.ts`) is their
compatibility plus the opinions of the memories `from` holds of `to`, clamped to
`social.affinityRange` (10). Readers (seats, the planner's `self.affinity`, the digest) call
`affinityOf`/`affinitiesFrom`; a retuned weight changes every relationship at once. Why: a running
total climbed to +10 within a week and nobody cooled; a decayed total was rejected because it
erases character along with the drift.

Compatibility is symmetric and fixed: `social.compatibility` base 2, minus 0.5 per point of summed
value-axis gap, plus 1 per shared like, minus 1 per like of one that the other dislikes (both
ways), rounded, clamped to +-2.

### Memories

Memories are a closed set (`MEMORY_KEYS`) the sim raises; each has an opinion (never 0), duration
(3 to 14 days; a fight's rescue and abandonment last longest, §thoughts-and-memories-from-a-fight)
and stack limit (1 to 2) in `social.memories`. A memory past its stack limit
refreshes the one expiring soonest, so repetition holds weight but never grows it. The social
system drops expired memories each tick, and entries with nothing left (and no chat time), and
people who have left. Between two crew, the sim's memories reach +7 at most (+9 with
compatibility); only the captain's table and the private talk go past that. Why: DF-style limited
close-friend slots are deferred until the narrator needs a lasting bond. The narrator's own keys
(`betrayedMe`, `savedMyLife`, `wrongedOverSomeone`, `madeItRight`) are raised by nothing in the sim
and may be lasting, never expiring (§memory-levers).

### Ambient chat

Every 20 ticks two awake crew (passengers too) on one deck within `social.chatRadiusTiles` (2),
neither on a task and both past `social.chatCooldownSeconds` (45), have a one-line `conversation`
from `social.templateLines` (`systems/work/ambient.ts`). Nobody in a fight chats, nor anyone in
the party while the expedition is under way (any phase but `resolved`), and the cast never do
(§the-combat-system-owns-its-combatants). Each pair's line is drawn from the lines that may come up
now: a gated line only while its condition holds (§chat-line-conditions), and no line said within
the repeat window (§chat-line-repeats). With none left the pair says nothing this pass.

A conversation leaves each side a memory unless the pair last had a memorable one within
`social.chatMemoryEveryDays` (2): `chatted`, or `rubbedWrong` with chance
`social.chatSour.atZero - perPoint * compatibility` (0.25, 0.1; 5% to 45%). The sides roll apart,
so a pair that does not click cools by talking (`social/chat.ts`).

### Chat line conditions

A template line is a string, or `{line, when}` with `when` one of a closed set
(`CHAT_LINE_CONDITIONS`, the content schema's enum), each read from the world as the chat comes
round:

- `paidDockingFee`: docked at a port where she paid the docking fee (§travel-stages), so never at a
  site or at the port a run starts from;
- `docked`: docked at a port, never a site; `underWay`: not docked;
- `pumpSymptom`: a `cooling`-tagged machine (the coolant pump) has a fault, known or not;
- `afterFight`: an expedition fought (it had contact) and resolved within `social.chatRecentDays`
  (1);
- `someoneWounded`: one of the ship's company, aboard and alive, carries a wound
  (§wounds-and-the-damage-entry-point);
- `hullScarred`: the hull has a scar not yet plated (§hull-scars-and-ship-loss);
- `fieldRecently`: the leg's asteroid field ended within `social.chatRecentDays`;
- `kitsLow`: fewer `medical` units aboard than `medical.reserve` (§medical-supplies).

Why: chat blind to the ship asked whether the coolant pump always sounds like that long after
the pump was mended.

### Chat line repeats

A template said within `social.templateRepeatDays` (0.5) is not drawn again, nor twice in one
pass; `SocialState.chatSaid` keeps the tick each line (by its text) was last said, absent in an
older save and read as nothing said. A window of 0 lets a line come up every pass (the fixtures'
one or two lines). Why: drawn freely, a handful of lines came round so often the ticker read as a
loop.

### Seats and the captain's table

Eating chooses a free mess seat (`social/seating.ts`): a held seat stays; else a seat beside
nobody at or below `social.avoidBelow` (-3), preferring one beside someone with affinity above
`social.preferAbove` (0); every seat beside an avoided person means the floor spot. "Beside" is
arm's reach. Once a ship's day the captain sits beside the crew member at the tables they have the
highest affinity with (even days) or lowest (odd days; the avoid rule does not apply); both
remember `sharedATable` and the crew member gets `satWithTheCaptain`.

## The private talk

### Private talk

`privateTalk { warm | stern }` is a card side effect the player chooses (§private-talk-effect) and a
player-authority command. It summons a crew member, through the planner (a summons the view carries,
`essentialOperation`, never `pendingIntent`), to the command actor's cabin: the captain's, or the
first officer's in the officers' cabin when standing in. The command is refused
(`preconditionFailed`) for the command actor, a passenger, someone ashore, while a talk is pending,
or without a cabin.

The talk counts `cabins.privateTalkSeconds` (20) while both are in the cabin on their `confer`
steps. Warm: the crew member remembers `heardMeOut` and the caller `talkedItThrough`, thought
`heardOut`. Stern: `dressedMeDown` and nothing, thought `dressedDown`. A talk not held within
`cabins.privateTalkWaitSeconds` (120), or whose party is gone or ashore, is missed
(`privateTalkMissed`). Events: `privateTalkCalled`, `privateTalkHeld`.

A helm stander or oncoming is never offered the summons (rejected `atTheHelm`) and the talk waits
and is missed. Why: both are essential, and at the departure hand-off a nearer cabin won the tie
and left the helm. The narrator's lever count is unaffected: it is a card effect, not a lever.
