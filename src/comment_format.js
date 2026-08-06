export const RUN_DETAILS_MARKER = "<!-- boxy-run-details -->";
export const RUN_DETAILS_SUMMARY = "🧾 Boxy's run details";

/**
 * Let's wrap it up
 */
export function buildRunDetailsBlock(sections) {
  const parts = (sections || []).map(section => (section || "").trim()).filter(Boolean);
  if (parts.length === 0) return "";

  return `<details>\n<summary>${RUN_DETAILS_SUMMARY}</summary>\n${RUN_DETAILS_MARKER}\n\n${parts.join("\n\n")}\n\n</details>`;
}

/**
 * Returns null when the body has no parent block to insert into.
 */
export function insertRunDetailsSection(body, section) {
  const text = typeof body === "string" ? body : "";
  const nested = (section || "").trim();
  if (!nested || !text.includes(RUN_DETAILS_MARKER)) return null;

  return text.replace(RUN_DETAILS_MARKER, `${RUN_DETAILS_MARKER}\n\n${nested}`);
}

const EMPTY_RUN_DETAILS_BLOCK = new RegExp(
  `<details>\\s*<summary>${RUN_DETAILS_SUMMARY}</summary>\\s*${RUN_DETAILS_MARKER}\\s*</details>\\s*`,
  "g"
);

/**
 * Drops a run details block that has nothing left inside it, which happens once
 * the tool activity log is stripped out of a comment that carried nothing else.
 */
export function stripEmptyRunDetailsBlock(body) {
  if (typeof body !== "string" || body.length === 0) return body || "";
  return body.replace(EMPTY_RUN_DETAILS_BLOCK, "");
}

function formatTokenCount(value) {
  return Number(value).toLocaleString("en-US");
}

/**
 * WHY CAN'T THE APIS JUST BE THE SAME THEN THIS HELPER WOULD NOT HAVE TO EXIST
 */
export function normalizeTokenUsage(usage) {
  if (!usage || typeof usage !== "object") return null;

  const pick = (...values) => {
    for (const value of values) {
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return null;
  };

  const input = pick(usage.prompt_tokens, usage.promptTokenCount, usage.input_tokens);
  const output = pick(usage.completion_tokens, usage.candidatesTokenCount, usage.output_tokens);
  const reasoning = pick(
    usage.completion_tokens_details?.reasoning_tokens,
    usage.thoughtsTokenCount,
    usage.reasoning_tokens
  );
  const cached = pick(
    usage.prompt_tokens_details?.cached_tokens,
    usage.cachedContentTokenCount,
    usage.cached_tokens
  );
  const total = pick(
    usage.total_tokens,
    usage.totalTokenCount,
    input !== null && output !== null ? input + output : null
  );

  if (input === null && output === null && total === null) return null;

  return { input, output, reasoning, cached, total };
}

/**
 * Renders the nested "tokens used" dropdown.
 */
export function formatTokenUsage(usage) {
  const totals = normalizeTokenUsage(usage);
  if (!totals) return "";

  const rows = [];
  if (totals.input !== null) rows.push(`| Input | ${formatTokenCount(totals.input)} |`);
  if (totals.cached !== null) rows.push(`| Cached input | ${formatTokenCount(totals.cached)} |`);
  if (totals.reasoning !== null) rows.push(`| Reasoning | ${formatTokenCount(totals.reasoning)} |`);
  if (totals.output !== null) rows.push(`| Output | ${formatTokenCount(totals.output)} |`);
  if (totals.total !== null) rows.push(`| **Total** | **${formatTokenCount(totals.total)}** |`);

  const heading = totals.total !== null ? ` (${formatTokenCount(totals.total)})` : "";
  const table = `| Kind | Tokens |\n| --- | ---: |\n${rows.join("\n")}`;

  return `<details>\n<summary>🎟️ Tokens used${heading}</summary>\n\n${table}\n\n</details>`;
}

/**
 * Renders the nested "current model identification" dropdown.
 */
export function formatModelIdentification(model) {
  if (!model) return "";
  return `<details>\n<summary>🤖 Current model identification</summary>\n\n*Current model identification: ${model}*\n\n</details>`;
}
