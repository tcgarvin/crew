/**
 * Cabins (slice 4): waking thoughts, the no-bunk thought, and `privateTalk` (the command, the
 * walk to the cabin and the talk). Register after `registerSocial` (same phase).
 */
import type { KernelRegistry, Unregister } from "../../core/registry";
import { cabinsSystem } from "./cabins";
import { privateTalkHandler } from "./private-talk";

export function registerCabins(registry: KernelRegistry): Unregister {
  const unregister = [
    registry.registerSystem(cabinsSystem),
    registry.registerCommandHandler("privateTalk", privateTalkHandler),
  ];
  return () => {
    for (const undo of unregister) undo();
  };
}

export { cabinsSystem, onWoke } from "./cabins";
export {
  leaveTalk,
  privateTalkHandler,
  privateTalkPlan,
  runConfer,
  talkCabin,
} from "./private-talk";
