import { useCallback, useMemo, useRef, useState } from "react";

const TOAST_MS = 4_000;

/**
 * What raised a toast: a `slowdown` names an auto-slowdown (§auto-slowdown) and is stale once the
 * player picks a speed again; a `notice` (a rejected command) stands until its timer.
 */
export type ToastKind = "notice" | "slowdown";

export interface ToastNote {
  readonly message: string;
  readonly kind: ToastKind;
}

/**
 * §toasts: the message to draw, or `undefined`. A toast never covers a decision card, so nothing
 * shows while one is up.
 */
export function toastOnScreen(note: ToastNote | undefined, cardUp: boolean): string | undefined {
  return cardUp ? undefined : note?.message;
}

/** §toasts: the toast left after the player picks a speed; a slowdown's is dropped. */
export function afterPlayerSpeedChange(note: ToastNote | undefined): ToastNote | undefined {
  return note?.kind === "slowdown" ? undefined : note;
}

export interface ToastProps {
  readonly note: ToastNote | undefined;
  /** A decision card is up (or closing with its aftermath): the toast is not drawn. */
  readonly cardUp: boolean;
}

/**
 * Small transient notice above the bottom edge (e.g. a rejected player command,
 * §decision-queue-and-halts).
 */
export function Toast({ note, cardUp }: ToastProps) {
  const message = toastOnScreen(note, cardUp);
  if (message === undefined) return null;
  return (
    <output className="toast" aria-live="polite">
      {message}
    </output>
  );
}

export interface ToastControls {
  /** Replace the toast and hide it after `TOAST_MS`. */
  readonly show: (message: string, kind?: ToastKind) => void;
  /** Drop a slowdown's toast at once (the player set a speed). */
  readonly onPlayerSpeedChange: () => void;
  /** Drop whatever toast is up (a card came up over it). */
  readonly dismiss: () => void;
}

/** The toast and stable controls for it. */
export function useToast(): readonly [ToastNote | undefined, ToastControls] {
  const [note, setNote] = useState<ToastNote>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((message: string, kind: ToastKind = "notice") => {
    setNote({ message, kind });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setNote(undefined), TOAST_MS);
  }, []);
  const onPlayerSpeedChange = useCallback(() => setNote(afterPlayerSpeedChange), []);
  const dismiss = useCallback(() => setNote(undefined), []);
  const controls = useMemo(
    (): ToastControls => ({ show, onPlayerSpeedChange, dismiss }),
    [show, onPlayerSpeedChange, dismiss],
  );
  return [note, controls];
}
