import { describe, expect, test } from "bun:test";
import { interpretCorsResponse, parseWikilinks, tagsMatchLoreFilter } from "./obsidian";

describe("parseWikilinks", () => {
  test("extracts a simple link", () => {
    expect(parseWikilinks("See [[Alice]] for more.")).toEqual(["Alice"]);
  });

  test("strips aliases and headings, keeps the bare note name", () => {
    expect(parseWikilinks("[[Alice|the queen]] and [[Bob#History]]")).toEqual(["Alice", "Bob"]);
  });

  test("uses the last path segment for folder-qualified links", () => {
    expect(parseWikilinks("[[Characters/Alice]]")).toEqual(["Alice"]);
  });

  test("dedupes case-insensitively and ignores empty links", () => {
    expect(parseWikilinks("[[Alice]] [[alice]] [[]] no links here")).toEqual(["Alice"]);
  });

  test("returns an empty array when there are no links", () => {
    expect(parseWikilinks("plain text")).toEqual([]);
  });
});

describe("interpretCorsResponse", () => {
  test("treats a raw JSON string as a 200 body and parses it", () => {
    const result = interpretCorsResponse('{"files":["a.md"]}');
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ files: ["a.md"] });
  });

  test("reads a {status, body} object with a string body", () => {
    const result = interpretCorsResponse({ status: 404, body: "not found" });
    expect(result.status).toBe(404);
    expect(result.text).toBe("not found");
  });

  test("reads an object body under the 'data' key", () => {
    const result = interpretCorsResponse({ status: 200, data: { files: ["x.md"] } });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ files: ["x.md"] });
  });

  test("treats a bare object (no status/body) as the decoded payload", () => {
    const result = interpretCorsResponse({ files: ["a.md", "b/"] });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ files: ["a.md", "b/"] });
  });

  test("defaults status to 200 when absent", () => {
    const result = interpretCorsResponse({ body: '{"ok":true}' });
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ ok: true });
  });
});

describe("tagsMatchLoreFilter", () => {
  test("an empty filter matches every note", () => {
    expect(tagsMatchLoreFilter([], "")).toBe(true);
    expect(tagsMatchLoreFilter(["anything"], "  ")).toBe(true);
  });

  test("matches an exact tag, case-insensitively and ignoring a leading #", () => {
    expect(tagsMatchLoreFilter(["Lore"], "lore")).toBe(true);
    expect(tagsMatchLoreFilter(["lore"], "#lore")).toBe(true);
  });

  test("matches nested child tags", () => {
    expect(tagsMatchLoreFilter(["lore/character"], "lore")).toBe(true);
  });

  test("does not match unrelated or merely-prefixed tags", () => {
    expect(tagsMatchLoreFilter(["worldbuilding"], "lore")).toBe(false);
    expect(tagsMatchLoreFilter(["lorekeeper"], "lore")).toBe(false);
  });
});
