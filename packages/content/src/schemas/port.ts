/** `PortDef` schema. */
import type { PortDef } from "@crew/sim";
import { z } from "zod";
import {
  itemDefIdSchema,
  localKeySchema,
  nonNegativeInt,
  portDefIdSchema,
  positive,
  positiveInt,
} from "./primitives";

/**
 * Expeditions A1 (§3.1): a port, or a site. A port has two or three cast seeds and at least one
 * external store; a site (`kind: "site"`) sells nothing (no market, no job templates), may have
 * no cast seeds or stores, names its `nearPortId`, and has exactly one route, to it. That no port
 * lists a site in its routes is L2's.
 */
export const portDefSchema = z
  .strictObject({
    id: portDefIdSchema,
    name: z.string().min(1),
    /** Dockside §3.3: station or planet; drives arrival scenery only. */
    setting: z.enum(["station", "planet"]),
    description: z.string(),
    /** Passengers spec §2.4: two or three sentences of port character for the narrator. */
    character: z.string().min(1),
    /** Passengers spec §2.4: two or three named recurring locals. */
    castSeed: z
      .array(
        z.strictObject({
          name: z.string().min(1),
          role: z.string().min(1),
          note: z.string().min(1),
          /** Dockside §5.2: a post key on this port's dock map (checked at L2). */
          post: localKeySchema.exactOptional(),
        }),
      )
      .max(3),
    externalStores: z.array(
      z.strictObject({
        key: localKeySchema,
        name: z.string().min(1),
        kind: z.enum(["warehouse", "market", "lounge"]),
      }),
    ),
    /** §market-stock: opening stock; `count` may be 0 so a port can price a part it is out of. */
    market: z.array(
      z.strictObject({ itemDefId: itemDefIdSchema, count: nonNegativeInt, price: positiveInt }),
    ),
    jobTemplates: z.array(
      z.strictObject({
        key: localKeySchema,
        issuer: z.string().min(1),
        toPortId: portDefIdSchema,
        cargo: z
          .array(
            z.strictObject({
              itemDefId: itemDefIdSchema,
              countMin: positiveInt,
              countMax: positiveInt,
            }),
          )
          .min(1),
        weight: positive,
      }),
    ),
    routes: z.array(z.strictObject({ toPortId: portDefIdSchema, distance: positive })),
    /** Expeditions A1 (§3.1): `site` for a landing site; absent is a port. */
    kind: z.enum(["port", "site"]).exactOptional(),
    /** Expeditions A1 (§3.1): the port a site lies near; site only. */
    nearPortId: portDefIdSchema.exactOptional(),
  })
  .superRefine((port, ctx) => {
    const problem = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (port.kind !== "site") {
      if (port.castSeed.length < 2) problem("castSeed", "a port needs two or three cast seeds");
      if (port.externalStores.length < 1) problem("externalStores", "a port needs a store");
      if (port.nearPortId !== undefined) problem("nearPortId", "only a site lies near a port");
      return;
    }
    if (port.market.length > 0) problem("market", "a site sells nothing");
    if (port.jobTemplates.length > 0) problem("jobTemplates", "a site offers no jobs");
    if (port.nearPortId === undefined) problem("nearPortId", "a site names the port it lies near");
    const [only, ...more] = port.routes;
    if (only === undefined || more.length > 0 || only.toPortId !== port.nearPortId) {
      problem("routes", "a site has exactly one route, to its nearPortId");
    }
  }) satisfies z.ZodType<PortDef>;
