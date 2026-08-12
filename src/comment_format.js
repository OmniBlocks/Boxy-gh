export const RUN_DETAILS_MARKER = "<!-- boxy-run-details -->";
export const RUN_DETAILS_SUMMARY = "😈 Boxy's evil plans";

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

const DETAILS_TAG = /<\/?details\b[^>]*>/gi;

function findDetailsClose(text, start) {
  DETAILS_TAG.lastIndex = start;
  let depth = 0;
  let match;

  while ((match = DETAILS_TAG.exec(text)) !== null) {
    depth += match[0][1] === "/" ? -1 : 1;
    if (depth === 0) return match.index + match[0].length;
  }

  return -1;
}

export function stripRunDetailsBlock(body) {
  let text = typeof body === "string" ? body : "";

  for (let marker = text.indexOf(RUN_DETAILS_MARKER); marker !== -1; marker = text.indexOf(RUN_DETAILS_MARKER)) {
    const start = text.lastIndexOf("<details", marker);
    const end = start === -1 ? -1 : findDetailsClose(text, start);

    if (end === -1) {
      text = text.slice(0, marker) + text.slice(marker + RUN_DETAILS_MARKER.length);
      continue;
    }

    text = text.slice(0, start) + text.slice(end);
  }

  return text.replace(/\n{3,}/g, "\n\n");
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
