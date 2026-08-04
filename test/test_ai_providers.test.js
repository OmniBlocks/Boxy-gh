import { describe, test } from "node:test";
import assert from "node:assert";
import { filterProviders } from "../src/ai.js";

const providers = [
  { name: "gemini-3.5-flash", type: "google", model: "gemini-3.5-flash" },
  { name: "groq-llama-3.3-70b-versatile", type: "groq", model: "llama-3.3-70b-versatile" },
  { name: "pollinations-kimi-k3", type: "pollinations", model: "vendouple/kimi-k3" },
  { name: "pollinations-gemma-4-31b-it", type: "pollinations", model: "Bakhshi7889/gemma-4-31b-it" }
];

const names = list => list.map(p => p.name);

describe("filterProviders", () => {
  test("keeps everything when nothing is configured", () => {
    assert.deepStrictEqual(filterProviders(providers, { enabled: "", disabled: "" }), providers);
  });

  test("disables a single provider by name", () => {
    const result = filterProviders(providers, { disabled: "pollinations-kimi-k3" });
    assert.deepStrictEqual(names(result), [
      "gemini-3.5-flash",
      "groq-llama-3.3-70b-versatile",
      "pollinations-gemma-4-31b-it"
    ]);
  });

  test("disables a whole provider type", () => {
    const result = filterProviders(providers, { disabled: "pollinations" });
    assert.deepStrictEqual(names(result), ["gemini-3.5-flash", "groq-llama-3.3-70b-versatile"]);
  });

  test("allow list keeps only matching providers", () => {
    const result = filterProviders(providers, { enabled: "google, pollinations-kimi-k3" });
    assert.deepStrictEqual(names(result), ["gemini-3.5-flash", "pollinations-kimi-k3"]);
  });

  test("disable wins over allow", () => {
    const result = filterProviders(providers, { enabled: "pollinations", disabled: "pollinations-kimi-k3" });
    assert.deepStrictEqual(names(result), ["pollinations-gemma-4-31b-it"]);
  });

  test("matching is case insensitive and ignores whitespace", () => {
    const result = filterProviders(providers, { disabled: "  GROQ ,, Pollinations  " });
    assert.deepStrictEqual(names(result), ["gemini-3.5-flash"]);
  });

  test("falls back to env vars when no options are passed", () => {
    const previousDisabled = process.env.BOXY_DISABLED_PROVIDERS;
    const previousEnabled = process.env.BOXY_ENABLED_PROVIDERS;
    process.env.BOXY_DISABLED_PROVIDERS = "google,groq";
    delete process.env.BOXY_ENABLED_PROVIDERS;
    try {
      assert.deepStrictEqual(names(filterProviders(providers)), [
        "pollinations-kimi-k3",
        "pollinations-gemma-4-31b-it"
      ]);
    } finally {
      if (previousDisabled === undefined) {
        delete process.env.BOXY_DISABLED_PROVIDERS;
      } else {
        process.env.BOXY_DISABLED_PROVIDERS = previousDisabled;
      }
      if (previousEnabled === undefined) {
        delete process.env.BOXY_ENABLED_PROVIDERS;
      } else {
        process.env.BOXY_ENABLED_PROVIDERS = previousEnabled;
      }
    }
  });
})