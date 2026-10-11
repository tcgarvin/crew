/**
 * §requested-call-back: the narrator's call-back request, its eighth command. It schedules nothing
 * in the world: it records when the narrator wants its next call (`NarratorState.callBack`) and
 * why.
 */
import type { CallBackWhen } from "../decisions";

export interface CallBackCommandPayloads {
  /**
   * §requested-call-back, narrator: replace the standing call-back request. `why` is a private
   * line, at most `CALL_BACK_WHY_MAX` characters with no control characters, read back on the call
   * it asks for. `holdQuiet` asks the quiet check-in to wait twice as long, once.
   */
  requestCall: {
    readonly when: CallBackWhen;
    readonly why: string;
    /** Double the quiet window while this request stands; absent is false. */
    readonly holdQuiet?: boolean;
  };
}
