// Client for a self-hosted Firecrawl server (https://github.com/firecrawl/firecrawl):
// web search, pages rendered with a real browser and turned into Markdown, site
// maps and small crawls. Self-hosted Firecrawl needs no API key by default.

import { httpRequest } from "./platform";
import type { SearchResult } from "./search";

export interface FirecrawlPage {
  url: string;
  title?: string;
  markdown: string;
}

async function call<T>(base: string, path: string, body?: unknown, timeoutMs = 90_000): Promise<T> {
  const res = await httpRequest({
    method: body === undefined ? "GET" : "POST",
    url: `${base.replace(/\/+$/, "")}${path}`,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    timeoutMs,
  });
  let j: any = null;
  try {
    j = JSON.parse(res.body);
  } catch {
    /* not JSON */
  }
  if (res.status >= 400 || j?.success === false) {
    throw new Error(`Firecrawl ${res.status}: ${j?.error ?? j?.message ?? res.body.slice(0, 300) ?? "request failed"}`);
  }
  return j as T;
}

export async function firecrawlSearch(base: string, query: string, max: number, withContent = false): Promise<SearchResult[]> {
  const body: Record<string, unknown> = { query, limit: max };
  if (withContent) body.scrapeOptions = { formats: ["markdown"], onlyMainContent: true };
  const j = await call<{ data: any[] | { web?: any[] } }>(base, "/v1/search", body, withContent ? 120_000 : 30_000);
  const items: any[] = Array.isArray(j.data) ? j.data : (j.data?.web ?? []);
  return items.map((r) => ({ title: r.title ?? r.metadata?.title ?? "", url: r.url ?? r.metadata?.sourceURL ?? "", snippet: r.description ?? "", content: r.markdown }));
}

export async function firecrawlScrape(base: string, url: string): Promise<FirecrawlPage & { status?: number }> {
  const j = await call<{ data: { markdown?: string; metadata?: { title?: string; sourceURL?: string; statusCode?: number } } }>(base, "/v1/scrape", {
    url,
    formats: ["markdown"],
    onlyMainContent: true,
  });
  return { url: j.data.metadata?.sourceURL ?? url, title: j.data.metadata?.title, markdown: j.data.markdown ?? "", status: j.data.metadata?.statusCode };
}

export async function firecrawlMap(base: string, url: string, search?: string, limit = 100): Promise<string[]> {
  const j = await call<{ links?: (string | { url: string })[] }>(base, "/v1/map", { url, search: search || undefined, limit });
  return (j.links ?? []).map((l) => (typeof l === "string" ? l : l.url));
}

/** Crawls up to `limit` pages of a site and waits for the result (a few minutes at most). */
export async function firecrawlCrawl(base: string, url: string, limit: number, includePaths: string[] = [], signal?: AbortSignal): Promise<FirecrawlPage[]> {
  const start = await call<{ id: string }>(base, "/v1/crawl", {
    url,
    limit,
    includePaths: includePaths.length ? includePaths : undefined,
    scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
  });
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
    await new Promise((r) => setTimeout(r, 2500));
    const s = await call<{ status: string; data?: any[] }>(base, `/v1/crawl/${encodeURIComponent(start.id)}`);
    if (s.status === "completed" || Date.now() > deadline) {
      return (s.data ?? []).map((d) => ({ url: d.metadata?.sourceURL ?? "", title: d.metadata?.title, markdown: d.markdown ?? "" }));
    }
    if (s.status === "failed" || s.status === "cancelled") throw new Error(`Firecrawl crawl ${s.status}`);
  }
}
