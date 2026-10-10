/** Expeditions A1 (§8.6): the shore header leads the headline while a site is alongside. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Headline, shoreHeader } from "./Headline";

describe("shoreHeader", () => {
  it("gives one word a side", () => {
    expect(shoreHeader({ us: "steady", them: "breaking" })).toBe("Us: steady · Them: breaking");
    expect(shoreHeader({ us: "shaky", them: "done" })).toBe("Us: shaky · Them: done");
  });
});

describe("Headline", () => {
  it("is the ship's line alone with no expedition", () => {
    const html = renderToStaticMarkup(<Headline text="Docked at Tern's Rest" alert={false} />);
    expect(html).toContain("Docked at Tern&#x27;s Rest");
    expect(html).not.toContain("Us:");
  });

  it("leads with the shore header at a site, tinted while on alert", () => {
    const expedition = { phase: "fight" as const, us: "steady" as const, them: "shaky" as const };
    const calm = renderToStaticMarkup(
      <Headline text="Docked at The Boathouse" expedition={expedition} alert={false} />,
    );
    expect(calm).toContain("Us: steady · Them: shaky");
    expect(calm).toContain("Docked at The Boathouse");
    expect(calm).not.toContain("headline-alert");
    const alarmed = renderToStaticMarkup(
      <Headline text="Docked at The Boathouse" expedition={expedition} alert={true} />,
    );
    expect(alarmed).toContain("headline-alert");
  });

  it("drops the shore header once the fight is resolved, keeping the alert's tint", () => {
    const expedition = {
      phase: "resolved" as const,
      us: "steady" as const,
      them: "steady" as const,
    };
    const html = renderToStaticMarkup(
      <Headline text="Docked at The Boathouse" expedition={expedition} alert={true} />,
    );
    expect(html).not.toContain("Us:");
    expect(html).toContain("Docked at The Boathouse");
    expect(html).toContain("headline-alert");
  });
});
