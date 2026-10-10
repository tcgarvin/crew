import { useCallback, useRef, useState } from "react";

const TOAST_MS = 4_000;

export interface ToastProps {
  readonly message: string | undefined;
}

/**
 * Small transient notice above the bottom edge (e.g. a rejected player command,
 * §decision-queue-and-halts).
 */
export function Toast({ message }: ToastProps) {
  if (message === undefined) return null;
  return (
    <output className="toast" aria-live="polite">
      {message}
    </output>
  );
}

/** The toast's message and a stable `show` that replaces it and hides it after `TOAST_MS`. */
export function useToast(): readonly [string | undefined, (message: string) => void] {
  const [message, setMessage] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((next: string) => {
    setMessage(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(undefined), TOAST_MS);
  }, []);
  return [message, show];
}
