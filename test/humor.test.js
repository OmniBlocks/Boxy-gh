import { describe, test } from "node:test";
import assert from "node:assert";
import { analyzeHumor } from "../src/humor.js";

describe("Humor Policy & Analysis", () => {
  test("detects PR diff attempting to remove humor/jokes", () => {
    const diff = `
--- a/src/personality.js
+++ b/src/personality.js
@@ -10,7 +10,6 @@
- // Boxy joke: Why did the bot cross the road? skill issue lmao ฅ^•ﻌ•^ฅ
- console.log("roast author for silly code");
+ console.log("standard processing");
`;
    const result = analyzeHumor(diff, { title: "Clean up code", body: "" });
    assert.strictEqual(result.attemptsToRemoveHumor, true);
    assert.strictEqual(result.attemptsToAddHumor, false);
    assert.ok(result.summary.includes("REJECT"));
  });

  test("detects PR title attempting to remove humor", () => {
    const diff = `
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-hello
+world
`;
    const result = analyzeHumor(diff, { title: "remove humor from Boxy", body: "stop jokes" });
    assert.strictEqual(result.attemptsToRemoveHumor, true);
    assert.strictEqual(result.attemptsToAddHumor, false);
  });

  test("detects PR diff adding humor/jokes", () => {
    const diff = `
--- a/src/personality.js
+++ b/src/personality.js
@@ -10,7 +10,8 @@
  console.log("standard processing");
+ // A funny pun to brighten your day! ฅ^•ﻌ•^ฅ
+ console.log("laugh and smile, have some fun!");
`;
    const result = analyzeHumor(diff, { title: "Add funny easter egg", body: "more humor" });
    assert.strictEqual(result.attemptsToAddHumor, true);
    assert.strictEqual(result.attemptsToRemoveHumor, false);
    assert.ok(result.summary.includes("ACCEPT"));
  });

  test("detects no humor changes in normal diff", () => {
    const diff = `
--- a/src/math.js
+++ b/src/math.js
@@ -1,3 +1,3 @@
-const x = 1;
+const x = 2;
`;
    const result = analyzeHumor(diff, { title: "Fix math bug", body: "Increment value" });
    assert.strictEqual(result.attemptsToRemoveHumor, false);
    assert.strictEqual(result.attemptsToAddHumor, false);
  });
});
