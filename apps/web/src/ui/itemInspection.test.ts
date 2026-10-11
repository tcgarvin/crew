import type { DeepReadonly, ItemId, JobErrand, PortDefId, WorldState } from "@crew/sim";
import { describe, expect, it } from "vitest";
import { buildDeckLayout } from "../render/deckLayout";
import { loadWebContent } from "../worker/content";
import { errandWords, inspectItem } from "./itemInspection";

const { bundle, scenarioId } = loadWebContent();
const scenario = bundle.scenarios[scenarioId];
const deck = scenario === undefined ? undefined : bundle.decks[scenario.deckId];
if (deck === undefined) throw new Error("no deck");
const layout = buildDeckLayout(deck, bundle);

const HARROW_END = "port.harrow_end" as PortDefId;
const HUB = "port.crossroads_hub" as PortDefId;

function errand(overrides: Partial<JobErrand> = {}): JobErrand {
  return {
    kind: "fetchPerson",
    siteId: HARROW_END,
    targetName: "Teodor Lusk",
    wants: "alive",
    returnToPortId: HUB,
    ...overrides,
  };
}

/** A snapshot with one item on a job: freight to Kessler, or an errand home to the Hub. */
function snapshot(job: { errand?: JobErrand; toPortId?: PortDefId; status?: string }) {
  return {
    items: {
      i1: {
        defId: "item.crate_general",
        jobId: "job1",
        location: { kind: "onDeck", deckId: layout.deckId, x: 1.5, y: 1.5 },
        stacking: "unique",
      },
    },
    deck: {},
    defs: { dynamic: { items: {} } },
    jobs: {
      job1: {
        id: "job1",
        issuer: "Ysolde Maren, Meridian Growers",
        fromPortId: HUB,
        toPortId: job.toPortId ?? HUB,
        status: job.status ?? "inTransit",
        cargo: [],
        cargoItemIds: [],
        ...(job.errand === undefined ? {} : { errand: job.errand }),
      },
    },
    actors: {},
  } as unknown as DeepReadonly<WorldState>;
}

describe("errandWords (expeditions A2, §6)", () => {
  it("says who is brought back, from which site and how, and where home is", () => {
    expect(errandWords(errand(), bundle)).toEqual({
      what: "Bring back Teodor Lusk from Harrow End, alive",
      home: "Crossroads Hub",
    });
    expect(errandWords(errand({ wants: "either" }), bundle).what).toMatch(/, alive or dead$/);
    expect(errandWords(errand({ wants: "dead" }), bundle).what).toMatch(/, dead$/);
  });

  it("reads a site whose name has an article mid-sentence", () => {
    const site = Object.values(bundle.ports).find(
      (p) => p.kind === "site" && p.name.startsWith("The "),
    );
    if (site === undefined) throw new Error("no site named with an article");
    const what = errandWords(errand({ siteId: site.id }), bundle).what;
    expect(what).toBe(`Bring back Teodor Lusk from ${site.name.replace(/^The /, "the ")}, alive`);
  });

  it("fetches a thing by its name, else by its item's", () => {
    const item = Object.values(bundle.items)[0];
    if (item === undefined) throw new Error("no items");
    const named = errand({
      kind: "fetchItem",
      targetName: "the strongbox papers",
      wants: "either",
    });
    expect(errandWords(named, bundle).what).toBe("Fetch the strongbox papers from Harrow End");
    const unnamed = errand({ kind: "fetchItem", targetName: "", itemDefId: item.id });
    expect(errandWords(unnamed, bundle).what).toBe(
      `Fetch ${item.name.toLowerCase()} from Harrow End`,
    );
  });

  it("never shows a number (§cards-never-mention-pay)", () => {
    const words = errandWords(errand(), bundle);
    expect(`${words.what} ${words.home}`).not.toMatch(/\d/);
  });
});

describe("inspectItem's job line", () => {
  it("names the errand for an item on one", () => {
    const item = inspectItem(snapshot({ errand: errand() }), "i1" as ItemId, bundle, layout);
    expect(item?.job).toMatchObject({
      issuer: "Ysolde Maren, Meridian Growers",
      status: "inTransit",
      errand: { what: "Bring back Teodor Lusk from Harrow End, alive", home: "Crossroads Hub" },
    });
  });

  it("leaves freight as freight", () => {
    const freight = snapshot({ toPortId: "port.kessler_drift" as PortDefId, status: "accepted" });
    const item = inspectItem(freight, "i1" as ItemId, bundle, layout);
    expect(item?.job).toEqual({
      issuer: "Ysolde Maren, Meridian Growers",
      from: "Crossroads Hub",
      to: "Kessler Drift",
      status: "accepted",
    });
  });
});
