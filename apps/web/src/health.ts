import { useEffect, useState } from "react";

export type HealthResponse = { ok: boolean };

export type HealthState = "checking" | "ok" | "error";

export function describeHealth(response: HealthResponse): "ok" | "error" {
  return response.ok ? "ok" : "error";
}

/** The API health dot: one `/api/health` check on mount. */
export function useApiHealth(): HealthState {
  const [health, setHealth] = useState<HealthState>("checking");
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: HealthResponse) => {
        if (!cancelled) setHealth(describeHealth(body));
      })
      .catch(() => {
        if (!cancelled) setHealth("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return health;
}
