import { describe, expect, it } from "vitest";
import { rawBundle } from "../loader";
import { validateBundle } from "./validate";

type Raw = { items: Record<string, { tags: string[]; nutrition?: number }> };

const MEAL = "item.hot_meal";
const PROVISIONS = "item.provisions";

/** The authored bundle with `edit` applied; every issue message, path first. */
function messagesAfter(edit: (items: Raw["items"]) => void): string[] {
  const raw = structuredClone(rawBundle()) as unknown as Raw;
  edit(raw.items);
  const result = validateBundle(raw);
  return result.ok ? [] : result.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

function itemOf(items: Raw["items"], id: string): Raw["items"][string] {
  const found = items[id];
  if (found === undefined) throw new Error(`authored bundle has no ${id}`);
  return found;
}

describe("galley items (D81)", () => {
  it("accepts the authored items", () => {
    expect(messagesAfter(() => {})).toEqual([]);
  });

  it("rejects a bundle with no meal item", () => {
    const messages = messagesAfter((items) => {
      const meal = itemOf(items, MEAL);
      meal.tags = meal.tags.filter((t) => t !== "meal");
    });
    expect(messages).toContain('items: expected exactly one "meal"-tagged item, found 0');
  });

  it("rejects a bundle with two meal items", () => {
    const messages = messagesAfter((items) => {
      const crate = itemOf(items, PROVISIONS);
      crate.tags = [...crate.tags, "meal", "food"];
      crate.nutrition = 0.1;
    });
    expect(messages).toContain('items: expected exactly one "meal"-tagged item, found 2');
  });

  it("rejects a meal that is not food", () => {
    const messages = messagesAfter((items) => {
      const meal = itemOf(items, MEAL);
      meal.tags = meal.tags.filter((t) => t !== "food");
    });
    expect(messages).toContain(`items.${MEAL}.tags: meal "${MEAL}" must be food with a nutrition`);
  });

  it("rejects a meal with no nutrition", () => {
    const messages = messagesAfter((items) => {
      const { nutrition: _dropped, ...withoutNutrition } = itemOf(items, MEAL);
      items[MEAL] = withoutNutrition;
    });
    expect(messages).toContain(`items.${MEAL}.tags: meal "${MEAL}" must be food with a nutrition`);
  });

  it("rejects a bundle with no provisions item", () => {
    const messages = messagesAfter((items) => {
      const crate = itemOf(items, PROVISIONS);
      crate.tags = crate.tags.filter((t) => t !== "provisions");
    });
    expect(messages).toContain('items: expected at least one "provisions"-tagged item');
  });
});
