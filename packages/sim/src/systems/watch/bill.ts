/**
 * The watch bill as it stands aboard (§sections-and-dayworkers). Not stored: it is the crew's
 * sections (`Actor.schedule.section`), read off the actors. The generator for a scenario without a
 * bill is `core/watch-bill.ts` (world creation needs it, and core does not import systems).
 *
 * Owner: W1 of ship life slice 2.
 */
import type { LocalKey } from "../../core/types/ids";
import type { ActorId } from "../../core/types/ids";
import type { ReadonlyWorldState } from "../../core/types/pipeline";

export { generateWatchBill } from "../../core/watch-bill";

export interface WatchBillSection {
  readonly key: LocalKey;
  /** The watch of the day this section stands. */
  readonly index: number;
  readonly members: readonly ActorId[];
}

/** The live bill: sections in watch order, and the dayworkers. Crew only, passengers excluded. */
export interface WatchBill {
  readonly sections: readonly WatchBillSection[];
  readonly dayworkers: readonly ActorId[];
}

export function watchBillOf(state: ReadonlyWorldState): WatchBill {
  const byIndex = new Map<number, { key: LocalKey; members: ActorId[] }>();
  const dayworkers: ActorId[] = [];
  for (const actor of Object.values(state.actors)) {
    if (!actor.crew || actor.passenger === true) continue;
    const section = actor.schedule.section;
    if (section === undefined) {
      dayworkers.push(actor.id);
      continue;
    }
    const entry = byIndex.get(section.index);
    if (entry === undefined) byIndex.set(section.index, { key: section.key, members: [actor.id] });
    else entry.members.push(actor.id);
  }
  const sections = [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, { key, members }]) => ({ key, index, members }));
  return { sections, dayworkers };
}
