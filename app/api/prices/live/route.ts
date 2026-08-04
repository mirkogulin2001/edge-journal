import { NextResponse } from "next/server";

const cache = new Map<string, { data: Record<string, number>; ts: number }>();
const CACHE_TTL = 30_000;

/**
 * Extract a usable price from a yahoo-finance2 quote object.
 * Tries several fields in priority order since v2 responses
 * can have missing/undefined fields depending on market hours
 * and ticker type.
 */
function extractPrice(quote: Record<string, unknown>): number {
  const fields = [
    "regularMarketPrice",
    "regularMarketPreviousClose",
    "regularMarketOpen",
    "postMarketPrice",
    "preMarketPrice",
    "ask",
    "bid",
  ];
  for (const field of fields) {
    const val = quote?.[field];
    if (typeof val === "number" && val > 0 && isFinite(val)) {
      return val;
    }
  }
  return 0;
}

/**
 * Fallback: fetch a quote from Yahoo Finance's v8 chart endpoint
 * using plain HTTP when the yahoo-finance2 library fails entirely.
 */
async function fetchPriceFallback(ticker: string): Promise<number> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
    },
  });
  if (!res.ok) {
    console.error(`[live-prices] Fallback HTTP ${res.status} for ${ticker}`);
    return 0;
  }
  const json = await res.json();
  const meta = json?.chart?.result?.[0]?.meta;
  if (!meta) {
    console.error(`[live-prices] Fallback: no meta in response for ${ticker}`);
    return 0;
  }
  const price =
    meta.regularMarketPrice ??
    meta.previousClose ??
    meta.chartPreviousClose ??
    0;
  return typeof price === "number" && price > 0 ? price : 0;
}

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

  const result: Record<string, number> = {};
  let libraryAvailable = true;

  // --- Attempt 1: yahoo-finance2 library ---
  try {
    const yahooFinance = (await import("yahoo-finance2")).default;

    const quotes = await Promise.allSettled(
      tickers.map(async (ticker) => {
        try {
          const quote = await yahooFinance.quote(ticker);
          console.log(
            `[live-prices] yahoo-finance2 quote for ${ticker}:`,
            JSON.stringify({
              regularMarketPrice: (quote as Record<string, unknown>).regularMarketPrice,
              regularMarketPreviousClose: (quote as Record<string, unknown>).regularMarketPreviousClose,
              regularMarketOpen: (quote as Record<string, unknown>).regularMarketOpen,
              symbol: (quote as Record<string, unknown>).symbol,
            })
          );
          const price = extractPrice(quote as Record<string, unknown>);
          return { ticker, price };
        } catch (tickerErr) {
          console.error(
            `[live-prices] yahoo-finance2 failed for ticker ${ticker}:`,
            tickerErr instanceof Error ? tickerErr.message : tickerErr
          );
          return { ticker, price: 0 };
        }
      })
    );

    for (const q of quotes) {
      if (q.status === "fulfilled" && q.value.price > 0) {
        result[q.value.ticker] = q.value.price;
      }
    }
  } catch (libErr) {
    console.error(
      "[live-prices] yahoo-finance2 import/init failed, will try fallback:",
      libErr instanceof Error ? libErr.message : libErr
    );
    libraryAvailable = false;
  }

  // --- Attempt 2: HTTP fallback for any tickers that still have no price ---
  const missingTickers = tickers.filter((t) => !(t in result) || result[t] <= 0);
  if (missingTickers.length > 0) {
    console.log(
      `[live-prices] ${libraryAvailable ? "Library returned no price" : "Library unavailable"} for [${missingTickers.join(", ")}], trying HTTP fallback`
    );
    const fallbacks = await Promise.allSettled(
      missingTickers.map(async (ticker) => {
        try {
          const price = await fetchPriceFallback(ticker);
          if (price > 0) {
            console.log(`[live-prices] Fallback got price for ${ticker}: ${price}`);
          }
          return { ticker, price };
        } catch (err) {
          console.error(
            `[live-prices] Fallback fetch error for ${ticker}:`,
            err instanceof Error ? err.message : err
          );
          return { ticker, price: 0 };
        }
      })
    );

    for (const f of fallbacks) {
      if (f.status === "fulfilled" && f.value.price > 0) {
        result[f.value.ticker] = f.value.price;
      }
    }
  }

  // Cache whatever we got (even partial results)
  if (Object.keys(result).length > 0) {
    cache.set(cacheKey, { data: result, ts: Date.now() });
  }

  return NextResponse.json(result);
}
