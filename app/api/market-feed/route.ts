import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface MarketQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
  category: string;
}

const MARKET_TICKERS: { symbol: string; name: string; category: string }[] = [
  // US Indices
  { symbol: "^GSPC", name: "S&P 500", category: "ÍNDICES" },
  { symbol: "^IXIC", name: "Nasdaq", category: "ÍNDICES" },
  { symbol: "^DJI", name: "Dow Jones", category: "ÍNDICES" },
  { symbol: "^RUT", name: "Russell 2000", category: "ÍNDICES" },
  { symbol: "^VIX", name: "VIX", category: "ÍNDICES" },
  // Futures
  { symbol: "ES=F", name: "S&P Futures", category: "FUTUROS" },
  { symbol: "NQ=F", name: "Nasdaq Futures", category: "FUTUROS" },
  { symbol: "YM=F", name: "Dow Futures", category: "FUTUROS" },
  // Commodities
  { symbol: "GC=F", name: "Oro", category: "COMMODITIES" },
  { symbol: "SI=F", name: "Plata", category: "COMMODITIES" },
  { symbol: "CL=F", name: "Petróleo WTI", category: "COMMODITIES" },
  // Currencies
  { symbol: "DX-Y.NYB", name: "Dólar Index", category: "MONEDAS" },
  { symbol: "EURUSD=X", name: "EUR/USD", category: "MONEDAS" },
  // Crypto
  { symbol: "BTC-USD", name: "Bitcoin", category: "CRYPTO" },
  { symbol: "ETH-USD", name: "Ethereum", category: "CRYPTO" },
];

let _cache: { data: MarketQuote[]; ts: number } | null = null;
const CACHE_TTL = 60_000;

async function fetchQuotesFallback(): Promise<MarketQuote[]> {
  const results: MarketQuote[] = [];

  const batches: string[][] = [];
  const symbols = MARKET_TICKERS.map((t) => t.symbol);
  for (let i = 0; i < symbols.length; i += 5) {
    batches.push(symbols.slice(i, i + 5));
  }

  for (const batch of batches) {
    const fetches = batch.map(async (sym) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2d`;
        const res = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0" },
        });
        if (!res.ok) return null;
        const json = await res.json();
        const meta = json?.chart?.result?.[0]?.meta;
        if (!meta) return null;

        const price = meta.regularMarketPrice ?? 0;
        const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price;
        const change = price - prevClose;
        const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;
        const info = MARKET_TICKERS.find((t) => t.symbol === sym)!;

        return {
          symbol: sym,
          name: info.name,
          price,
          change: Math.round(change * 100) / 100,
          changePct: Math.round(changePct * 100) / 100,
          category: info.category,
        } as MarketQuote;
      } catch {
        return null;
      }
    });

    const batchResults = await Promise.allSettled(fetches);
    for (const r of batchResults) {
      if (r.status === "fulfilled" && r.value && r.value.price > 0) {
        results.push(r.value);
      }
    }
  }

  return results;
}

async function fetchQuotes(): Promise<MarketQuote[]> {
  try {
    const yahooFinance = (await import("yahoo-finance2")).default;
    const results: MarketQuote[] = [];

    const quotes = await Promise.allSettled(
      MARKET_TICKERS.map(async (info) => {
        try {
          const q = (await yahooFinance.quote(info.symbol)) as Record<string, unknown>;
          const price = (q.regularMarketPrice as number) ?? 0;
          const change = (q.regularMarketChange as number) ?? 0;
          const changePct = (q.regularMarketChangePercent as number) ?? 0;

          if (price <= 0) return null;

          return {
            symbol: info.symbol,
            name: info.name,
            price: Math.round(price * 100) / 100,
            change: Math.round(change * 100) / 100,
            changePct: Math.round(changePct * 100) / 100,
            category: info.category,
          } as MarketQuote;
        } catch {
          return null;
        }
      })
    );

    for (const q of quotes) {
      if (q.status === "fulfilled" && q.value) {
        results.push(q.value);
      }
    }

    if (results.length > 0) return results;
  } catch (e) {
    console.error("[market-feed] yahoo-finance2 failed:", e instanceof Error ? e.message : e);
  }

  return fetchQuotesFallback();
}

export async function GET() {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL) {
    return NextResponse.json(_cache.data);
  }

  const data = await fetchQuotes();
  if (data.length > 0) {
    _cache = { data, ts: Date.now() };
  }

  return NextResponse.json(data);
}
