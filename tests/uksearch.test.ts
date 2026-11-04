// The UK Trade Tariff search cross-check (stages.ukSearch) against mocked API answers: query relaxation, exact
// matches, fuzzy matches, chapter-level codes skipped, and a network failure.
import { afterEach, expect, test, vi } from "vitest";
import { ukSearch } from "../src/lib/engine/stages";

afterEach(() => vi.unstubAllGlobals());

function api(answers: Record<string, unknown>[]) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(decodeURIComponent(new URL(url).searchParams.get("q")!));
    return new Response(JSON.stringify(answers.shift() ?? {}));
  });
  return asked;
}

test("relaxes the query until the API answers, skipping chapter-level codes", async () => {
  const fuzzy = { data: { attributes: { type: "fuzzy_match", goods_nomenclature_match: { commodities: [
    { _source: { goods_nomenclature_item_id: "6400000000" + "00", description: "chapter" } },
    { _source: { goods_nomenclature_item_id: "6403919800", ancestor_descriptions: ["Footwear", "Other", "Covering the ankle"] } }] } } } };
  const asked = api([{ data: { attributes: { type: "fuzzy_match" } } }, fuzzy]);
  expect(await ukSearch("men's leather chelsea boots")).toEqual([["6403919800", "Footwear > Other > Covering the ankle"]]);
  expect(asked).toEqual(["men leather chelsea boots", "chelsea boots"]);
});

test("an exact match pads the code to 10 digits", async () => {
  api([{ data: { attributes: { type: "exact_search", entry: { id: "640391" } } } }]);
  expect(await ukSearch("640391 boots")).toEqual([["6403910000", "boots"]]);
});

test("a network failure gives no reference rather than an error", async () => {
  vi.stubGlobal("fetch", async () => { throw new Error("offline"); });
  expect(await ukSearch("leather boots")).toEqual([]);
});
