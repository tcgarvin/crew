export type HealthResponse = { ok: boolean };

export function describeHealth(response: HealthResponse): "ok" | "error" {
  return response.ok ? "ok" : "error";
}
