export interface ToastProps {
  readonly message: string | undefined;
}

/** Small transient notice above the bottom edge (e.g. "narrator unavailable — carrying on"). */
export function Toast({ message }: ToastProps) {
  if (message === undefined) return null;
  return (
    <output className="toast" aria-live="polite">
      {message}
    </output>
  );
}
