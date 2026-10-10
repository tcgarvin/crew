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

Content validation is per deck: a venue the deck has seats `participants.max` (at most four, one
plate); a non-contest group activity says how it is done alone; `{ref}` appears only in labels of
thoughts that carry a `refId`. A deck no scenario sails gets notes, not failures.

### Choosing recreation

The planner offers one recreation candidate per person, the best-scored activity
(`planner/recreation.ts`). Off duty it needs recreation above `recreation.joinAbove` (0.25), and
only joining an open session below `needs.seekThreshold`; on duty it needs the need above the seek
threshold and is `voluntaryActivity`, so any task wins but an idle cook bakes or plays. Off duty it
is `routineObligation`. Why: off watch everyone is in a voluntary rest or chat hold, which a
voluntary candidate never interrupts, so voluntary joins never filled a table.

Score: interest 3 (strong like), 2, 1, 0 (a dislike is never chosen); +2 to join an open session
with room; +1 to host a group activity; +0.5 for a session holding someone liked, never a session
holding someone at or below `social.avoidBelow`; +1 for group play in good mood, solo only in low
mood. Joining needs score >= 1, hosting a like, solo play >= 1. Ties go to join over host over solo,
then nearer, then the bigger table. Rest and chat take `needUrgency`, and one taken because the
need pressed ends when the need is met. Why: otherwise routine games beat voluntary chat every
time and helm standers came on watch lonely.

### Group sessions

A session is common knowledge (`AgentView.sessions()`) at a venue; one game of a kind runs at a
time. A host opens it, whoever is there joins (not past `recreation.lateJoinSeconds` (20) of
running). It starts at max members or after `recreation.gatherSeconds` (45) with min; with fewer
it collapses to the solo variant and the host backs off that activity
`recreation.collapseBackoffDays` (0.1). A contest or debate falling under min is abandoned. A
leaver, whatever takes them off, leaves the session that tick; a host who leaves hands it on.
Outcomes resolve once through `resolveOutcome` and the row is deleted; a solo play resolves through
a one-member row never stored and still says `sessionEnded`. Restoration is proportional, so an
interrupted game restores in part, and waiting restores nothing (`recreation/needs.ts`).

Personal items are fetched and put back: an owned instrument from its locker, a book from the
shelf to the player's desk (the lounge without a cabin).

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
- **Bond**: members who like the activity warm to each other.
- All: skill gain, dirt, risk (a sparring knock is a thought and a line), and a product. Baking
  puts treats on the counter tagged `treat`, never `meal`, so a treat never answers the mess call;
  it is eaten as a snack above `galley.treatHungerAbove` (0.1) hunger.

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
(3 to 7 days) and stack limit (1 to 2) in `social.memories`. A memory past its stack limit
refreshes the one expiring soonest, so repetition holds weight but never grows it. The social
system drops expired memories each tick, and entries with nothing left (and no chat time), and
people who have left. Between two crew, memories reach +7 at most (+9 with compatibility); only the
captain's table and the private talk go past that. Why: DF-style limited close-friend slots are
deferred until the narrator needs a lasting bond.

### Ambient chat

A conversation leaves each side a memory unless the pair last had a memorable one within
`social.chatMemoryEveryDays` (2): `chatted`, or `rubbedWrong` with chance
`social.chatSour.atZero - perPoint * compatibility` (0.25, 0.1; 5% to 45%). The sides roll apart,
so a pair that does not click cools by talking (`social/chat.ts`).

### Seats and the captain's table

Eating chooses a free mess seat (`social/seating.ts`): a held seat stays; else a seat beside
nobody at or below `social.avoidBelow` (-3), preferring one beside someone with affinity above
`social.preferAbove` (0); every seat beside an avoided person means the floor spot. "Beside" is
arm's reach. Once a ship's day the captain sits beside the crew member at the tables they have the
highest affinity with (even days) or lowest (odd days; the avoid rule does not apply); both
remember `sharedATable` and the crew member gets `satWithTheCaptain`.

## The private talk

### Private talk

`privateTalk { warm | stern }` is a card side effect the player chooses (see `cards.md`) and a
player-authority command. It summons a crew member, through the planner (a summons the view carries,
`essentialOperation`, never `pendingIntent`), to the command actor's cabin: the captain's, or the
first officer's in the officers' cabin when standing in. The command is refused
(`preconditionFailed`) for the command actor, a passenger, someone ashore, while a talk is pending, or without a cabin.

The talk counts `cabins.privateTalkSeconds` (20) while both are in the cabin on their `confer`
steps. Warm: the crew member remembers `heardMeOut` and the caller `talkedItThrough`, thought
`heardOut`. Stern: `dressedMeDown` and nothing, thought `dressedDown`. A talk not held within
`cabins.privateTalkWaitSeconds` (120), or whose party is gone or ashore, is missed
(`privateTalkMissed`). Events: `privateTalkCalled`, `privateTalkHeld`.

A helm stander or oncoming is never offered the summons (rejected `atTheHelm`) and the talk waits
and is missed. Why: both are essential, and at the departure hand-off a nearer cabin won the tie
and left the helm. The narrator's lever count is unaffected: it is a card effect, not a lever.
