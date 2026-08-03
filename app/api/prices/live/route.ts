import { NextResponse } from "next/server";

const cache = new Map<string, { data: Record<string, number>; ts: number }>();
const CACHE_TTL = 30_000;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const tickersParam = searchParams.get("tickers");
  if (!tickersParam) return NextResponse.json({});

  const tickers = tickersParam.split(",").filter(Boolean);
  if (tickers.length === 0) return NextResponse.json({});

  const cacheKey = tickers.sort().join(",");
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  try {
    const yahooFinance = (await import("yahoo-finance2")).default;
    const result: Record<string, number> = {};

    const quotes = await Promise.allSettled(
      tickers.map(async (ticker) => {
        const quote = await yahooFinance.quote(ticker);
        return { ticker, price: quote.regularMarketPrice ?? 0 };
      })
    );

    for (const q of quotes) {
      if (q.status === "fulfilled" && q.value.price > 0) {
        result[q.value.ticker] = q.value.price;
      }
    }

    cache.set(cacheKey, { data: result, ts: Date.now() });
    return NextResponse.json(result);
  } catch (error) {
    console.error("Price fetch error:", error);
    if (cached) return NextResponse.json(cached.data);
    return NextResponse.json({}, { status: 500 });
  }
}
