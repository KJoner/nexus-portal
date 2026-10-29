/**
 * 搜索建议 via fixed OpenSearch suggestion endpoints. Only these three hosts are ever contacted, so
 * the query string is the only user input that leaves Nexus.
 */
const ENDPOINTS: Record<string, (q: string) => string> = {
  google: (q) => `https://suggestqueries.google.com/complete/search?client=firefox&ie=utf-8&oe=utf-8&q=${encodeURIComponent(q)}`,
  bing: (q) => `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}`,
  duckduckgo: (q) => `https://duckduckgo.com/ac/?type=list&q=${encodeURIComponent(q)}`,
};

export const suggestEngines = Object.keys(ENDPOINTS);

export async function fetchSuggestions(engine: string, q: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const url = ENDPOINTS[engine];
  if (!url) return [];
  const res = await fetchFn(url(q.slice(0, 100)), { redirect: 'error', signal: AbortSignal.timeout(2500), headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 Nexus/1' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = (await res.text()).slice(0, 64 * 1024);
  const body = JSON.parse(text) as unknown;
  // OpenSearch suggestions: [query, [s1, s2, …], …]
  const list = Array.isArray(body) && Array.isArray(body[1]) ? (body[1] as unknown[]) : [];
  return list.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 120)).slice(0, 8);
}
