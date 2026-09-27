import { describe, expect, it } from "vitest";
import { LexicalIndex, tokenize } from "../src/lexical.js";

describe("tokenize", () => {
  it("splits camelCase", () => {
    expect(tokenize("TestOrderCreate")).toEqual(["test", "order", "creat"]);
  });

  it("folds ё into е", () => {
    expect(tokenize("Покажи Ёлку")).toEqual(["покаж", "елку"]);
  });

  it("drops stopwords and words shorter than two chars", () => {
    expect(tokenize("use the find-bug skill a")).toEqual(["find", "bug", "skill"]);
  });

  it("keeps two-letter signal words", () => {
    expect(tokenize("MR CI db pr")).toEqual(["mr", "ci", "db", "pr"]);
  });

  it("drops two-letter function words in both languages", () => {
    // ё folds to е, so the е spelling is what the stopword list holds
    expect(tokenize("to of at вы она её ещё там")).toEqual([]);
  });

  it("cuts words longer than five chars", () => {
    expect(tokenize("running migrations")).toEqual(["runni", "migra"]);
  });

  it("returns nothing for empty or stopword-only text", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("и в на не the and for")).toEqual([]);
  });
});

const docs = [
  { name: "find-bug", text: "why does it crash stack trace fails" },
  { name: "cooking", text: "pasta recipe soup bread cooking" },
  { name: "empty", text: "" },
];

describe("LexicalIndex", () => {
  it("ranks the matching doc first and all docs by score then name", () => {
    const index = new LexicalIndex(docs);
    const ranked = index.rank("crash stack trace fails");
    expect(ranked.map((r) => r.name)).toEqual(["find-bug", "cooking", "empty"]);
    expect(ranked[0]?.score).toBeGreaterThan(0);
    expect(ranked[1]?.score).toBe(0);
  });

  it("splits ties by name", () => {
    const index = new LexicalIndex(docs);
    expect(index.rank("nothing known here").map((r) => r.name)).toEqual(["cooking", "empty", "find-bug"]);
  });

  it("similarity is symmetric and within [0, 1]", () => {
    const index = new LexicalIndex(docs);
    const ab = index.similarity("find-bug", "cooking");
    expect(ab).toBe(index.similarity("cooking", "find-bug"));
    expect(ab).toBeGreaterThanOrEqual(0);
    expect(ab).toBeLessThanOrEqual(1);
    expect(index.similarity("find-bug", "missing")).toBe(0);
  });

  it("identical texts give a pair score of about one", () => {
    // one-char names vanish in tokenize, so only the shared text carries weight
    const index = new LexicalIndex([
      { name: "a", text: "deploy helm charts staging clusters" },
      { name: "b", text: "deploy helm charts staging clusters" },
    ]);
    const pairs = index.pairs(0.5);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ a: "a", b: "b" });
    expect(pairs[0]?.score).toBeCloseTo(1, 6);
  });

  it("empty vectors score zero", () => {
    // a one-char name leaves the doc with no tokens at all
    const index = new LexicalIndex([{ name: "a", text: "" }]);
    expect(index.rank("crash stack trace")[0]?.score).toBe(0);
    expect(index.similarity("a", "a")).toBe(0);
  });

  it("pairs keeps only scores at or above the threshold", () => {
    const index = new LexicalIndex([
      { name: "aa", text: "one two three four five" },
      { name: "bb", text: "one two three four five" },
      { name: "cc", text: "completely different words here" },
    ]);
    expect(index.pairs(0).length).toBeGreaterThan(index.pairs(0.99).length);
    expect(index.pairs(2)).toEqual([]);
  });
});
