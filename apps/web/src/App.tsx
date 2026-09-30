import { useEffect, useState } from "react";

type HealthState = "checking" | "ok" | "error";

export function App() {
  const [health, setHealth] = useState<HealthState>("checking");

  useEffect(() => {
    let cancelled = false;

    fetch("/api/health")
      .then((res) => {
        if (!res.ok) {
          throw new Error(`health check failed: ${res.status}`);
        }
        return res.json() as Promise<{ ok: boolean }>;
      })
      .then((body) => {
        if (!cancelled) {
          setHealth(body.ok ? "ok" : "error");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHealth("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>Crew</h1>
      <p>API health: {health}</p>
    </main>
  );
}
