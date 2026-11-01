import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS ES module without types
import * as F from "../src/web/public/filters-logic.js";

const any = F as any;

const opts = [
  { name: "bug", count: 3 },
  { name: "ui", count: 3 },
  { name: "chore", count: 1 },
  { name: "Docs", count: 2 },
];

describe("label options", () => {
  it("sorts by count desc then name asc", () => {
    expect(any.sortLabelOptions(opts).map((o: any) => o.name)).toEqual(["bug", "ui", "Docs", "chore"]);
    expect(any.sortLabelOptions(undefined)).toEqual([]);
  });
  it("topLabels takes the first n", () => {
    expect(any.topLabels(opts, 2).map((o: any) => o.name)).toEqual(["bug", "ui"]);
    expect(any.topLabels(opts, 0)).toEqual([]);
    expect(any.topLabels(opts)).toHaveLength(4);
    expect(any.TOP_LABELS).toBe(5);
  });
  it("filterLabelOptions matches case-insensitive substrings, empty query returns all", () => {
    expect(any.filterLabelOptions(opts, "do").map((o: any) => o.name)).toEqual(["Docs"]);
    expect(any.filterLabelOptions(opts, "  B ").map((o: any) => o.name)).toEqual(["bug"]);
    expect(any.filterLabelOptions(opts, "")).toHaveLength(4);
    expect(any.filterLabelOptions(opts, "zzz")).toEqual([]);
  });
});

describe("label selection", () => {
  it("detects negation", () => {
    expect(any.isNegated("!bug")).toBe(true);
    expect(any.isNegated("bug")).toBe(false);
    expect(any.labelName("!bug")).toBe("bug");
    expect(any.labelName("bug")).toBe("bug");
  });
  it("counts selected labels hidden behind the dropdown", () => {
    const top = any.topLabels(opts, 2); // bug, ui
    expect(any.hiddenSelected(["bug", "chore", "Docs"], top)).toBe(2);
    expect(any.hiddenSelected(["!bug"], top)).toBe(0);
    expect(any.hiddenSelected([], top)).toBe(0);
  });
  it("toggles: add, remove, and positive wins over a negation", () => {
    expect(any.toggleLabel([], "bug")).toEqual(["bug"]);
    expect(any.toggleLabel(["bug", "ui"], "bug")).toEqual(["ui"]);
    expect(any.toggleLabel(["!bug"], "bug")).toEqual(["bug"]);
    expect(any.toggleLabel(["!bug", "chore"], "bug")).toEqual(["chore", "bug"]);
  });
  it("adds negations, dedupes and drops the positive twin", () => {
    expect(any.addNegation([], "bug")).toEqual(["!bug"]);
    expect(any.addNegation(["bug"], "bug")).toEqual(["!bug"]);
    expect(any.addNegation(["!bug"], "bug")).toEqual(["!bug"]);
  });
  it("removes by exact value", () => {
    expect(any.removeLabel(["bug", "!bug"], "!bug")).toEqual(["bug"]);
    expect(any.removeLabel(["bug"], "nope")).toEqual(["bug"]);
  });
});
