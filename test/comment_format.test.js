import { describe, test } from "node:test";
import assert from "node:assert";
import {
  RUN_DETAILS_MARKER,
  RUN_DETAILS_SUMMARY,
  getRunDetailsSummary,
  buildRunDetailsBlock,
  insertRunDetailsSection,
  stripRunDetailsBlock,
  normalizeTokenUsage,
  formatTokenUsage,
  formatModelIdentification,
} from "../src/comment_format.js";

describe("comment_format run details and summaries", () => {
  test("RUN_DETAILS_SUMMARY does not contain evil plans", () => {
    assert.strictEqual(RUN_DETAILS_SUMMARY, "🧾 Boxy's run details");
    assert.strictEqual(getRunDetailsSummary(), "🧾 Boxy's run details");
    assert.strictEqual(RUN_DETAILS_SUMMARY.includes("evil"), false);
  });

  test("buildRunDetailsBlock formats valid details block", () => {
    const block = buildRunDetailsBlock(["Step 1: Done"]);
    assert.ok(block.includes(`<summary>${RUN_DETAILS_SUMMARY}</summary>`));
    assert.ok(block.includes(RUN_DETAILS_MARKER));
    assert.ok(block.includes("Step 1: Done"));
  });

  test("buildRunDetailsBlock returns empty string on empty input", () => {
    assert.strictEqual(buildRunDetailsBlock([]), "");
    assert.strictEqual(buildRunDetailsBlock(null), "");
    assert.strictEqual(buildRunDetailsBlock(["   "]), "");
  });

  test("insertRunDetailsSection inserts into existing details block", () => {
    const initial = buildRunDetailsBlock(["Initial"]);
    const updated = insertRunDetailsSection(initial, "Followup");
    assert.ok(updated.includes("Initial"));
    assert.ok(updated.includes("Followup"));
  });

  test("stripRunDetailsBlock removes details block cleanly", () => {
    const block = buildRunDetailsBlock(["Activity Log"]);
    const fullComment = `${block}\n\nActual user response here.`;
    const stripped = stripRunDetailsBlock(fullComment);
    assert.strictEqual(stripped.trim(), "Actual user response here.");
  });

  test("normalizeTokenUsage normalizes various API token keys", () => {
    const raw = {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    };
    const normalized = normalizeTokenUsage(raw);
    assert.strictEqual(normalized.input, 100);
    assert.strictEqual(normalized.output, 50);
    assert.strictEqual(normalized.total, 150);
  });

  test("formatTokenUsage renders tokens markdown table", () => {
    const raw = {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
    };
    const rendered = formatTokenUsage(raw);
    assert.ok(rendered.includes("🎟️ Tokens used (150)"));
    assert.ok(rendered.includes("| Input | 100 |"));
    assert.ok(rendered.includes("| Output | 50 |"));
    assert.ok(rendered.includes("| **Total** | **150** |"));
  });

  test("formatModelIdentification renders model block", () => {
    const rendered = formatModelIdentification("gemini-3.5-flash-lite");
    assert.ok(rendered.includes("Current model identification: gemini-3.5-flash-lite"));
  });
});
