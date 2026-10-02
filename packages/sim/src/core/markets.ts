/**
 * Port markets (D47): pure helpers over `WorldState.markets` and `PortDef.market`, shared by
 * world creation, the commerce system, the render projection and the narrator (through the
 * package exports). Nothing here moves money or items; `systems/commerce/market.ts` does that.
 *
 * A port with no entry in `state.markets` reads as its content seed, so a save from before the
 * market existed (schema < 3) and a hand-built fixture both behave as if the port had just been
 * seeded; writers call `ensureMarket` first so the state slice exists before it changes.
 */
import type { ConfigDef, ContentBundle, PortDef } from "./types/content";
import type { ItemDefId, PortDefId } from "./types/ids";
import type { ReadonlyWorldState } from "./types/pipeline";
import type { MarketStock, WorldState } from "./types/state";

/** A port's opening stock, as content authored it (a `count: 0` line keeps its price). */
export function marketSeed(port: Pick<PortDef, "market">): MarketStock {
  const stock: MarketStock = {};
  for (const line of port.market) {
    stock[line.itemDefId] = { count: line.count, price: line.price };
  }
  return stock;
}

/** The live market at `portId`: state if the port has been seeded, else its content seed. */
export function effectiveMarket(
  state: Pick<ReadonlyWorldState, "markets">,
  content: Pick<ContentBundle, "ports">,
  portId: PortDefId,
): Readonly<MarketStock> {
  const live = state.markets[portId];
  if (live !== undefined) return live;
  const port = content.ports[portId];
  return port === undefined ? {} : marketSeed(port);
}

/** The live market at `portId`, seeded from content on first write. */
export function ensureMarket(
  state: Pick<WorldState, "markets">,
  content: Pick<ContentBundle, "ports">,
  portId: PortDefId,
): MarketStock {
  const live = state.markets[portId];
  if (live !== undefined) return live;
  const port = content.ports[portId];
  const seeded = port === undefined ? {} : marketSeed(port);
  state.markets[portId] = seeded;
  return seeded;
}

/**
 * The content price an item is reckoned against at `portId`: this port's authored line, else the
 * dearest authored line for it at any port, else `config.commerce.market.defaultPrice`. The
 * narrator's price tiers multiply this (`stockMarket`), so a "fair" restock of a part the port
 * already sells costs what content says it does.
 */
export function basePriceFor(
  content: Pick<ContentBundle, "ports">,
  config: Pick<ConfigDef, "commerce">,
  portId: PortDefId,
  itemDefId: ItemDefId,
): number {
  const here = content.ports[portId]?.market.find((line) => line.itemDefId === itemDefId);
  if (here !== undefined) return here.price;
  let dearest = 0;
  for (const port of Object.values(content.ports)) {
    for (const line of port.market) {
      if (line.itemDefId === itemDefId && line.price > dearest) dearest = line.price;
    }
  }
  return dearest > 0 ? dearest : config.commerce.market.defaultPrice;
}
