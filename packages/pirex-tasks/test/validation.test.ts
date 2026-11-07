import { describe, expect, it } from "vitest";
import { jsonOutput, decodeJson } from "../lib/validation.ts";
import { validateConfigText } from "../lib/config.ts";

describe("TypeBox JSON boundaries", () => {
  it("produces Pi-compatible JSON with standard serialization semantics", () => {
    expect(jsonOutput({ taskId: "t1", missing: undefined, values: [undefined, "한글"] })).toEqual({
      taskId: "t1",
      values: [null, "한글"],
    });
    expect(jsonOutput(null)).toBeNull();
  });
  it("rejects unserializable roots and bigint", () => {
    expect(() => jsonOutput(undefined)).toThrow();
    expect(() => jsonOutput(1n)).toThrow();
  });
  it("handles special object keys without changing prototypes", () => {
    const input: unknown = decodeJson('{"__proto__":{"polluted":true}}');
    const result = jsonOutput(input);
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
  it("rejects bad popup bounds and unknown config fields", () => {
    expect(() => validateConfigText("[popup]\nbounds = [0.8, 0.1, 0.8, 0.8]")).toThrow(
      "Invalid popup.bounds",
    );
    expect(() => validateConfigText("[execution]\nunknown = true")).toThrow();
  });
});
