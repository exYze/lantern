import { firecrawlSearch } from "./firecrawl";
import { httpRequest } from "./platform";
import type { Settings } from "./types";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** The page as Markdown, when the search engine read it too (Firecrawl). */
  content?: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Parses DuckDuckGo's HTML results page (no API key needed). */
export function parseDuckDuckGo(html: string, max: number): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1);
  for (const b of blocks) {
    const a = b.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = a[1].replace(/&amp;/g, "&");
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith("//")) url = "https:" + url;
    if (/duckduckgo\.com\/y\.js/.test(url)) continue; // ads
    const snip = b.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(a|div|td)>/);
    results.push({ title: decodeEntities(a[2]), url, snippet: snip ? decodeEntities(snip[1]) : "" });
    if (results.length >= max) break;
  }
  return results;
}

export async function webSearch(query: string, settings: Settings, max = 8, withContent = false): Promise<SearchResult[]> {
  const fc = settings.firecrawl;
  if (fc?.search && fc.url) {
    try {
      return await firecrawlSearch(fc.url, query, max, withContent);
    } catch (e) {
      // Fall back to the regular search engine so a Firecrawl outage doesn't stop the bot.
      console.warn("Firecrawl search failed, using the fallback engine", e);
    }
  }
  if (settings.search.kind === "searxng" && settings.search.url) {
    const url = `${settings.search.url.replace(/\/+$/, "")}/search?format=json&q=${encodeURIComponent(query)}`;
    const res = await httpRequest({ url, timeoutMs: 20000, headers: { Accept: "application/json" } });
    if (res.status >= 400) throw new Error(`SearXNG returned ${res.status}. Make sure the JSON format is enabled in its settings.`);
    const j = JSON.parse(res.body);
    return (j.results ?? []).slice(0, max).map((r: any) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.content ?? "" }));
  }
  const res = await httpRequest({
    method: "POST",
    url: "https://html.duckduckgo.com/html/",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" },
    body: `q=${encodeURIComponent(query)}&kl=wt-wt`,
    timeoutMs: 20000,
  });
  if (res.status >= 400) throw new Error(`Search failed with status ${res.status}`);
  return parseDuckDuckGo(res.body, max);
}
