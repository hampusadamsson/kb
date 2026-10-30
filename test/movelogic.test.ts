import { describe, expect, it } from "vitest";

import { moveTargets as _moveTargets } from "../src/web/public/logic.js";
describe("moveTargets", () => {
  it("excludes the current column", () => {
    expect(_moveTargets(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });
  it("keeps all columns for unsorted (null) and does not mutate", () => {
    const cols = ["a", "b"];
    expect(_moveTargets(cols, null)).toEqual(["a", "b"]);
    expect(cols).toEqual(["a", "b"]);
  });
});
