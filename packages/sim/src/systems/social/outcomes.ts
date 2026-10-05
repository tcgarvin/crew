/**
 * Outcomes (slice 4, call 5), resolved once at a session's end by the recreation system, which
 * then deletes the row (this module never touches `social.sessions`): contest (a winner by
 * `rng.weighted("social")` over `1 + interestScore`, the tally and streak, `win`/`lose` thoughts,
 * affinity, `keepsBeatingMe` and `rivalryStreak` at `social.rivalry.streakFor`), debate (a topic
 * from `def.topics`, stances by `stanceOn`, `spiritedTalk` or `argued` per pair, one `argument`
 * event, `gotLectured` for bystanders who do not like debate), perform (`enjoyedMusic` /
 * `hatedTheNoise` for everyone awake in the room but the performer), bond (`goodCompany`, +1 all
 * round), none; then `skillGain`, `dirt` (`depositDirt` at the venue tile), `produces` (a stack on
 * the zone's first tile with `Item.meal` set, `treatsBaked`) and `risk` (`sparringBruise`,
 * `tookAKnock`).
 *
 * Owner: W2 of ship life slice 4. Gate stub: no effect.
 */
import type { ActivityDef } from "../../core/types/content";
import type { StepCtx } from "../../core/types/pipeline";
import type { GroupSession } from "../../core/types/state";

export function resolveOutcome(_ctx: StepCtx, _session: GroupSession, _def: ActivityDef): void {}
