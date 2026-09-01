const DEFAULT_API_URL = "https://api.firecrawl.dev";
const SCRAPE_TIMEOUT_MS = 30000;
const REQUEST_TIMEOUT_MS = 45000;
const SEARCH_QUERY_MAX_LENGTH = 500;

export function firecrawlApiBase() {
  const raw = (process.env.FIRECRAWL_API_URL || DEFAULT_API_URL).trim().replace(/\/+$/, "");
  return /\/v\d+$/.test(raw) ? raw : `${raw}/v2`;
}

export function hasFirecrawl() {
  const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
  const apiUrl = process.env.FIRECRAWL_API_URL?.trim();
  try {
    const { protocol } = new URL(apiUrl);
    return Boolean(apiKey || (apiUrl && (protocol === "http:" || protocol === "https:")));
  } catch {
    return Boolean(apiKey);
  }
}

async function callFirecrawl(path, body) {
  if (!hasFirecrawl()) throw new Error("Neither FIRECRAWL_API_KEY nor FIRECRAWL_API_URL is set.");
  const apiKey = process.env.FIRECRAWL_API_KEY;

  const response = await fetch(`${firecrawlApiBase()}${path}`, {
    method: "POST",
    headers: {
      ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const detail = payload?.error || payload?.details || response.statusText || "";
    throw new Error(`Firecrawl ${path} responded with ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  if (payload?.success === false) {
    throw new Error(`Firecrawl ${path} failed: ${payload.error || "unknown error"}`);
  }
  return payload?.data ?? null;
}

function firstString(value) {
  if (Array.isArray(value)) return value.find((entry) => typeof entry === "string" && entry.trim()) || null;
  return typeof value === "string" && value.trim() ? value : null;
}

export async function firecrawlScrape(url) {
  const data = await callFirecrawl("/scrape", {
    url,
    formats: ["markdown"],
    onlyMainContent: true,
    timeout: SCRAPE_TIMEOUT_MS,
  });

  const markdown = typeof data?.markdown === "string" ? data.markdown.trim() : "";
  if (!markdown) throw new Error(`Firecrawl returned no readable text for ${url}.`);

  const metadata = data?.metadata || {};
  return {
    markdown,
    title: firstString(metadata.title),
    url: firstString(metadata.sourceURL) || firstString(metadata.url) || url,
    contentType: (firstString(metadata.contentType) || "").split(";")[0].trim().toLowerCase() || null,
    status: typeof metadata.statusCode === "number" ? metadata.statusCode : null,
  };
}

export async function firecrawlSearch(query, limit = 6) {
  if (typeof query !== "string" || query.length > SEARCH_QUERY_MAX_LENGTH) {
    throw new Error(`Firecrawl search queries must be at most ${SEARCH_QUERY_MAX_LENGTH} characters.`);
  }

  const data = await callFirecrawl("/search", {
    query,
    limit,
    sources: [{ type: "web" }],
  });

  const web = Array.isArray(data) ? data : (data?.web ?? []);
  const results = (Array.isArray(web) ? web : [])
    .map((item) => ({
      title: firstString(item?.title) || firstString(item?.metadata?.title),
      url: item?.url || firstString(item?.metadata?.sourceURL) || "",
      snippet: firstString(item?.description) || firstString(item?.metadata?.description),
    }))
    .filter((item) => item.url);

  return { results };
}