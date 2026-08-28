import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

interface CorrelationResult {
  symbols: string[];
  matrix: number[][];
}

const _cache: Record<string, { data: CorrelationResult; ts: number }> = {};
const CACHE_TTL = 600_000;

async function fetchHistorical(
  ticker: string,
  startDate: Date,
  endDate: Date
): Promise<Record<string, number>> {
  try {
    const yahooFinance = (await import("yahoo-finance2")).default;
    const result = await yahooFinance.historical(ticker, {
      period1: startDate.toISOString().split("T")[0],
      period2: endDate.toISOString().split("T")[0],
    });
    const prices: Record<string, number> = {};
    for (const row of result) {
      const d = new Date(row.date).toISOString().split("T")[0];
      const p = (row as Record<string, unknown>).adjClose as number ?? row.close;
      if (typeof p === "number" && p > 0) prices[d] = p;
    }
    if (Object.keys(prices).length > 0) return prices;
  } catch {}

  try {
    const period1 = Math.floor(startDate.getTime() / 1000);
    const period2 = Math.floor(endDate.getTime() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${period1}&period2=${period2}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return {};
    const json = await res.json();
    const r = json?.chart?.result?.[0];
    if (!r) return {};
    const timestamps: number[] = r.timestamp || [];
    const closes: number[] = r.indicators?.adjclose?.[0]?.adjclose || r.indicators?.quote?.[0]?.close || [];
    const prices: Record<string, number> = {};
    for (let i = 0; i < timestamps.length; i++) {
      const d = new Date(timestamps[i] * 1000).toISOString().split("T")[0];
      if (typeof closes[i] === "number" && closes[i] > 0) prices[d] = closes[i];
    }
    return prices;
  } catch {
    return {};
  }
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 5) return 0;
  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;
  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  const denom = Math.sqrt(varX * varY);
  return denom > 0 ? cov / denom : 0;
}

export async function GET(req: NextRequest) {
  const tickersParam = req.nextUrl.searchParams.get("tickers");
  const yearsParam = req.nextUrl.searchParams.get("years") || "1";

  if (!tickersParam) return NextResponse.json({ error: "tickers required" }, { status: 400 });

  const portfolioTickers = tickersParam.split(",").filter(Boolean);
  const benchmarks = ["SPY", "QQQ"];
  const allSymbols = Array.from(new Set([...portfolioTickers, ...benchmarks]));
  const years = Math.min(Math.max(parseInt(yearsParam) || 1, 1), 10);

  const cacheKey = `${allSymbols.sort().join(",")}_${years}y`;
  if (_cache[cacheKey] && Date.now() - _cache[cacheKey].ts < CACHE_TTL) {
    return NextResponse.json(_cache[cacheKey].data);
  }

  const endDate = new Date();
  const startDate = new Date();
  startDate.setFullYear(startDate.getFullYear() - years);

  const priceResults = await Promise.all(
    allSymbols.map((sym) => fetchHistorical(sym, startDate, endDate))
  );

  const priceMap: Record<string, Record<string, number>> = {};
  for (let i = 0; i < allSymbols.length; i++) {
    priceMap[allSymbols[i]] = priceResults[i];
  }

  const allDatesSet = new Set<string>();
  for (const prices of Object.values(priceMap)) {
    for (const d of Object.keys(prices)) allDatesSet.add(d);
  }
  const sortedDates = Array.from(allDatesSet).sort();

  const commonDates = sortedDates.filter((d) =>
    allSymbols.every((sym) => priceMap[sym]?.[d] != null)
  );

  const returns: Record<string, number[]> = {};
  for (const sym of allSymbols) {
    returns[sym] = [];
    for (let i = 1; i < commonDates.length; i++) {
      const prev = priceMap[sym][commonDates[i - 1]];
      const curr = priceMap[sym][commonDates[i]];
      returns[sym].push((curr - prev) / prev);
    }
  }

  const n = allSymbols.length;
  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        matrix[i][j] = 1;
      } else if (j > i) {
        const corr = pearsonCorrelation(returns[allSymbols[i]], returns[allSymbols[j]]);
        matrix[i][j] = Math.round(corr * 100) / 100;
        matrix[j][i] = matrix[i][j];
      }
    }
  }

  const result: CorrelationResult = { symbols: allSymbols, matrix };
  _cache[cacheKey] = { data: result, ts: Date.now() };

  return NextResponse.json(result);
}
