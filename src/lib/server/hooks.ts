// What the engine may reach outside the database for, in a live request: the AI (when a key is set) and the UK
// government's tariff search. UK_SEARCH=off switches the search off (parity tests and offline development).
import { askJson, available } from "../llm";
import { type Hooks, ukSearch } from "../engine/stages";

export function liveHooks(): Hooks {
  return {
    ukSearch: process.env.UK_SEARCH === "off" ? async () => [] : ukSearch,
    llmJson: available() ? askJson : null,
  };
}
