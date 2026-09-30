import { describe, expect, it } from "vitest";
import { contentJsonSchemas } from "./index";

describe("@crew/content JSON Schema export", () => {
  it("produces a JSON Schema object for every def schema", () => {
    const schemas = contentJsonSchemas();
    for (const schema of Object.values(schemas)) {
      expect(schema.type).toBe("object");
    }
    expect(schemas.item.additionalProperties).toBe(false);
  });
});
