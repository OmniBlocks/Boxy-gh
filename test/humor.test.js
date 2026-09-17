import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isHumorousLine, analyzeHumorInDiff } from "../src/humor.js";

describe("Humor Detection and Enforcement Engine", () => {
  describe("isHumorousLine", () => {
    it("identifies humor keywords", () => {
      assert.equal(isHumorousLine("// This is a funny joke about javascript"), true);
      assert.equal(isHumorousLine("const meme = 'doge';"), true);
      assert.equal(isHumorousLine("/* lol this shouldn't work but it does */"), true);
      assert.equal(isHumorousLine("// easter egg: play sound"), true);
      assert.equal(isHumorousLine("throw new Error('skill issue');"), true);
    });

    it("identifies humorous emojis and emoticons", () => {
      assert.equal(isHumorousLine("// Have fun 😂"), true);
      assert.equal(isHumorousLine("// Clowns everywhere 🤡"), true);
      assert.equal(isHumorousLine("// Don't break this :)"), true);
      assert.equal(isHumorousLine("// Table flip (╯°□°)╯"), true);
    });

    it("returns false for serious / non-humorous code lines", () => {
      assert.equal(isHumorousLine("function calculateTotal(items) {"), false);
      assert.equal(isHumorousLine("  return items.reduce((acc, x) => acc + x.price, 0);"), false);
      assert.equal(isHumorousLine("}"), false);
      assert.equal(isHumorousLine("import express from 'express';"), false);
    });
  });

  describe("analyzeHumorInDiff", () => {
    it("returns NEUTRAL when diff has no humor changes", () => {
      const diff = `
--- a/math.js
+++ b/math.js
@@ -1,3 +1,3 @@
-const a = 1;
+const a = 2;
`;
      const result = analyzeHumorInDiff(diff);
      assert.equal(result.removesHumor, false);
      assert.equal(result.addsHumor, false);
      assert.equal(result.recommendation, "NEUTRAL");
    });

    it("detects PR that attempts to remove humor and flags REJECT", () => {
      const diff = `
--- a/src/messages.js
+++ b/src/messages.js
@@ -10,5 +10,4 @@
-export const ERROR_MSG = "skill issue! lol you broke the build 😂";
-export const EASTER_EGG = "never gonna give you up";
+export const ERROR_MSG = "An internal error occurred.";
`;
      const result = analyzeHumorInDiff(diff);
      assert.equal(result.removesHumor, true);
      assert.equal(result.addsHumor, false);
      assert.equal(result.removedHumorCount, 2);
      assert.equal(result.addedHumorCount, 0);
      assert.equal(result.recommendation, "REJECT");
      assert.equal(result.reason.includes("remove humor"), true);
    });

    it("detects PR that adds humor and flags ACCEPT", () => {
      const diff = `
--- a/src/cli.js
+++ b/src/cli.js
@@ -20,3 +20,5 @@
 console.log("Starting server...");
+// Added a funny joke for developers
+console.log("Why do programmers prefer dark mode? Because light attracts bugs! 😂");
`;
      const result = analyzeHumorInDiff(diff);
      assert.equal(result.removesHumor, false);
      assert.equal(result.addsHumor, true);
      assert.equal(result.addedHumorCount, 2);
      assert.equal(result.removedHumorCount, 0);
      assert.equal(result.recommendation, "ACCEPT");
      assert.equal(result.reason.includes("adds humor"), true);
    });

    it("ignores unified diff headers (--- and +++)", () => {
      const diff = `
--- a/joke_service.js
+++ b/joke_service.js
@@ -1,2 +1,2 @@
-const val = 1;
+const val = 2;
`;
      const result = analyzeHumorInDiff(diff);
      assert.equal(result.removesHumor, false);
      assert.equal(result.addsHumor, false);
      assert.equal(result.recommendation, "NEUTRAL");
    });
  });
});
