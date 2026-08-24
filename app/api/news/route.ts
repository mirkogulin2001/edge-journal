import { NextRequest, NextResponse } from "next/server";

interface FinnhubNews {
  category: string;
  datetime: number;
  headline: string;
  id: number;
  image: string;
  related: string;
  source: string;
  summary: string;
  url: string;
}

export interface NewsItem {
  id: number;
  headline: string;
  summary: string;
  source: string;
  url: string;
  image: string;
  datetime: number;
  related: string;
}

let _generalCache: { data: NewsItem[]; ts: number } | null = null;
const _companyCache: Record<string, { data: NewsItem[]; ts: number }> = {};
const CACHE_TTL = 300_000;

function mapNews(items: FinnhubNews[]): NewsItem[] {
  return items.map((n) => ({
    id: n.id,
    headline: n.headline,
    summary: n.summary,
    source: n.source,
    url: n.url,
    image: n.image,
    datetime: n.datetime,
    related: n.related,
  }));
}

export async function GET(req: NextRequest) {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "FINNHUB_API_KEY not configured" },
      { status: 500 }
    );
  }

  const tickers = req.nextUrl.searchParams.get("tickers");
  const now = Date.now();

  // Company-specific news
  if (tickers) {
    const symbols = tickers.split(",").filter(Boolean).slice(0, 10);
    const allNews: NewsItem[] = [];

    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const fromStr = weekAgo.toISOString().split("T")[0];
    const toStr = today.toISOString().split("T")[0];

    const fetches = symbols.map(async (sym) => {
      const clean = sym.replace(".BA", "");
      if (_companyCache[clean] && now - _companyCache[clean].ts < CACHE_TTL) {
        return _companyCache[clean].data;
      }

      try {
        const res = await fetch(
          `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(clean)}&from=${fromStr}&to=${toStr}&token=${apiKey}`
        );
        if (!res.ok) return [];
        const data = (await res.json()) as FinnhubNews[];
        const mapped = mapNews(data).slice(0, 5);
        _companyCache[clean] = { data: mapped, ts: now };
        return mapped;
      } catch {
        return [];
      }
    });

    const results = await Promise.allSettled(fetches);
    for (const r of results) {
      if (r.status === "fulfilled") {
        allNews.push(...r.value);
      }
    }

    allNews.sort((a, b) => b.datetime - a.datetime);

    const seen = new Set<number>();
    const unique = allNews.filter((n) => {
      if (seen.has(n.id)) return false;
      seen.add(n.id);
      return true;
    });

    return NextResponse.json(unique.slice(0, 20));
  }

  // General market news
  if (_generalCache && now - _generalCache.ts < CACHE_TTL) {
    return NextResponse.json(_generalCache.data);
  }

  try {
    const url = `https://finnhub.io/api/v1/news?category=general&token=${apiKey}`;
    console.log(`[news] Fetching general news from Finnhub...`);
    const res = await fetch(url);
    console.log(`[news] Finnhub response status: ${res.status}`);
    if (!res.ok) {
      const body = await res.text();
      console.error(`[news] Finnhub error body: ${body}`);
      return NextResponse.json(
        { error: `Finnhub ${res.status}: ${body}` },
        { status: 502 }
      );
    }
    const data = (await res.json()) as FinnhubNews[];
    console.log(`[news] Got ${data.length} news items`);
    if (!Array.isArray(data)) {
      console.error(`[news] Unexpected response type: ${typeof data}`);
      return NextResponse.json(
        { error: "Finnhub returned unexpected format" },
        { status: 502 }
      );
    }
    const mapped = mapNews(data).slice(0, 15);
    _generalCache = { data: mapped, ts: now };
    return NextResponse.json(mapped);
  } catch (e) {
    console.error(`[news] Fetch error:`, e instanceof Error ? e.message : e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Fetch error" },
      { status: 502 }
    );
  }
}
