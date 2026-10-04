/**
 * Anonymous token auth (W8). `POST /api/auth/anon` mints a random token and stores its SHA-256
 * hash; every other route (except `/api/health`) requires `Authorization: Bearer <token>` and
 * resolves it to a user via the same hash.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Context, Next } from "hono";
import type { Db } from "./db/types";
import { apiError } from "./http";

const TOKEN_BYTES = 32;

export function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Crude best-effort per-IP rate limit for minting tokens: a fixed window, in-memory, per process. */
export class MintRateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly maxPerWindow = 20,
    private readonly windowMs = 60 * 60 * 1000,
  ) {}

  /** Returns true if the caller is still within budget (and records the hit). */
  allow(ip: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(ip);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.hits.set(ip, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= this.maxPerWindow) return false;
    entry.count += 1;
    return true;
  }
}

export function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  return "unknown";
}

declare module "hono" {
  interface ContextVariableMap {
    userId: string;
  }
}

/** The Hono env of every authed route: `requireAuth` sets `userId`. */
export interface AppEnv {
  Variables: { userId: string };
}

/** Middleware: resolves `Authorization: Bearer <token>` to a user id, or 401s. */
export function requireAuth(db: Db) {
  return async (c: Context, next: Next) => {
    const header = c.req.header("authorization") ?? c.req.header("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
    if (!token) {
      return apiError(c, 401, "unauthorized", "Missing Authorization: Bearer <token>.");
    }
    const user = await db.getUserByTokenHash(hashToken(token));
    if (!user) {
      return apiError(c, 401, "unauthorized", "Unknown or revoked token.");
    }
    c.set("userId", user.id);
    return next();
  };
}
