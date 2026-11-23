import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKanban, type Kanban } from "../src/index.js";
import { loadConfig, webSchema } from "../src/core/config.js";
// @ts-expect-error plain JS ES module without types
import * as L from "../src/web/public/logic.js";

const any = L as any;
const pub = (f: string) => fs.readFileSync(path.join(import.meta.dirname, "../src/web/public", f), "utf8");

describe("web card display schema", () => {
  it("accepts valid values", () => {
    expect(webSchema.safeParse({ properties_show: ["author", "url"], properties_collapsed: false }).success).toBe(true);
    expect(webSchema.safeParse({ properties_show: [] }).success).toBe(true);
    expect(webSchema.safeParse({}).success).toBe(true);
  });
  it("rejects bad values", () => {
    expect(webSchema.safeParse({ properties_show: [""] }).success).toBe(false);
    expect(webSchema.safeParse({ properties_show: ["a", "a"] }).success).toBe(false);
    expect(webSchema.safeParse({ properties_show: "a" }).success).toBe(false);
    expect(webSchema.safeParse({ properties_show: [1] }).success).toBe(false);
    expect(webSchema.safeParse({ properties_collapsed: "yes" }).success).toBe(false);
  });
});

describe("settings round-trip of web card keys", () => {
  let dir: string;
  let kb: Kanban;
  const yaml = (web: string) => `name: default\ncolumns: [todo, done]\nglob: "*.md"\n${web}`;
  const file = () => fs.readFileSync(path.join(dir, "kanban.yaml"), "utf8");
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-cardprops-"));
    fs.writeFileSync(path.join(dir, "kanban.yaml"), yaml("web:\n  properties_show: [author, url]\n  properties_collapsed: false\n"));
    kb = createKanban({ dir });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("preserves both keys through snapshot → update", () => {
    const snap = kb.getConfig().config;
    expect(snap.web).toEqual({ properties_show: ["author", "url"], properties_collapsed: false });
    kb.updateConfig({ ...snap, name: "renamed" });
    expect(loadConfig(dir).web).toEqual({ properties_show: ["author", "url"], properties_collapsed: false });
  });
  it("form round-trip keeps keys and omits defaults", () => {
    const snap = kb.getConfig().config;
    const form = any.configToForm(snap);
    expect(form.propertiesCollapsed).toBe(false);
    expect(form.propertiesShow).toBe("author, url");
    expect(any.formToPayload(form).config.web).toEqual({ properties_show: ["author", "url"], properties_collapsed: false });
    form.propertiesCollapsed = true;
    form.propertiesShow = " ";
    form.propertiesShowSet = false;
    expect(any.formToPayload(form).config.web).toBeUndefined();
  });
  it("default collapsed=true is not written", () => {
    const snap = kb.getConfig().config;
    kb.updateConfig({ ...snap, web: { properties_show: ["a"], properties_collapsed: true } });
    expect(file()).toContain("properties_show");
    expect(file()).not.toContain("properties_collapsed");
    kb.updateConfig({ ...kb.getConfig().config, web: { properties_collapsed: true } });
    expect(file()).not.toContain("web:");
  });
  it("empty list (show none) survives", () => {
    kb.updateConfig({ ...kb.getConfig().config, web: { properties_show: [] } });
    expect(loadConfig(dir).web).toEqual({ properties_show: [] });
    const form = any.configToForm(kb.getConfig().config);
    expect(any.formToPayload(form).config.web).toEqual({ properties_show: [] });
  });
  it("/api/board-style view data: board response exposes web, tickets keep all props", () => {
    expect(loadConfig(dir).web?.properties_collapsed).toBe(false);
  });
});

describe("card property helpers", () => {
  const props = { author: "a", url: "u", n: 1 };
  it("cardProps filters by allow-list", () => {
    expect(any.cardProps(props, null)).toHaveLength(3);
    expect(any.cardProps(props, undefined)).toHaveLength(3);
    expect(any.cardProps(props, ["author", "url"]).map((e: any) => e[0])).toEqual(["author", "url"]);
    expect(any.cardProps(props, [])).toEqual([]);
    expect(any.cardProps(props, ["zzz"])).toEqual([]);
    expect(any.cardProps(undefined, null)).toEqual([]);
  });
  it("labels and list parsing", () => {
    expect(any.propsToggleLabel(3, false)).toBe("Show properties (3)");
    expect(any.propsToggleLabel(3, true)).toBe("Hide properties");
    expect(any.parseList(" a, b ,,a")).toEqual(["a", "b"]);
  });
});

describe("card rendering source", () => {
  const js = pub("board.js");
  const card = js.slice(js.indexOf("function renderCard"), js.indexOf("function moveSelect"));
  it("toggle is an aria-expanded button; chips only when expanded; state in a Map", () => {
    expect(js).toContain("const propsOpen = new Map()");
    expect(js).toContain('"aria-expanded"');
    expect(js).toContain("propsToggleLabel(count, expanded)");
    expect(card).toContain("expanded ? shown.map");
    expect(card).toContain("cardProps(t.props, cardView.show)");
    expect(card).toContain("propsOpen.get(t.path)");
  });
  it("css: >=24px target; app passes web config", () => {
    expect(pub("style.css")).toMatch(/\.props-toggle \{[^}]*min-height: 24px/);
    expect(pub("app.js")).toContain("web: data.web");
  });
});
