/**
 * `Db` factory. Picks the in-memory fake (`CREW_DB=memory`, or no `DATABASE_URL` outside
 * production — `env.ts` already fails fast there) or a real Neon-backed `Db` otherwise.
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { Env } from "../env";
import { MemoryDb } from "./memory";
import { type DrizzleDatabase, DrizzleDb } from "./queries";
import * as schema from "./schema";
import type { Db } from "./types";

export function createNeonDatabase(databaseUrl: string): DrizzleDatabase {
  const sql = neon(databaseUrl);
  return drizzle(sql, { schema });
}

export function createDb(env: Env): Db {
  if (env.useMemoryDb || !env.databaseUrl) {
    return new MemoryDb();
  }
  return new DrizzleDb(createNeonDatabase(env.databaseUrl));
}

export type { Db } from "./types";
