import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

interface DailyRow {
  date: string;
  total_value: number;
  cash: number;
  equity_value: number;
  external_flow: number;
  daily_return: number;
  cumulative_return: number;
  spy_return: number;
  spy_drawdown: number;
}

const _cache: Record<string, { data: DailyRow[]; ts: number }> = {};
const CACHE_TTL = 300_000;

async function fetchHistoricalFallback(
  ticker: string,
  startDate: Date,
  endDate: Date
): Promise<Record<string, number>> {
  const period1 = Math.floor(startDate.getTime() / 1000);
  const period2 = Math.floor(endDate.getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${period1}&period2=${period2}`;

  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) {
      console.error(`[performance] HTTP fallback ${res.status} for ${ticker}`);
      return {};
    }
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return {};

    const timestamps: number[] = result.timestamp || [];
    const closes: number[] =
      result.indicators?.quote?.[0]?.close || [];
    const adjCloses: number[] =
      result.indicators?.adjclose?.[0]?.adjclose || closes;

    const prices: Record<string, number> = {};
    for (let i = 0; i < timestamps.length; i++) {
      const d = new Date(timestamps[i] * 1000).toISOString().split("T")[0];
      const p = adjCloses[i] ?? closes[i];
      if (typeof p === "number" && p > 0 && isFinite(p)) {
        prices[d] = p;
      }
    }
    return prices;
  } catch (err) {
    console.error(
      `[performance] HTTP fallback error for ${ticker}:`,
      err instanceof Error ? err.message : err
    );
    return {};
  }
}

async function fetchHistorical(
  ticker: string,
  startDate: Date,
  endDate: Date
): Promise<Record<string, number>> {
  // Try yahoo-finance2 library first
  try {
    const yahooFinance = (await import("yahoo-finance2")).default;
    const result = await yahooFinance.historical(ticker, {
      period1: startDate.toISOString().split("T")[0],
      period2: endDate.toISOString().split("T")[0],
    });
    const prices: Record<string, number> = {};
    for (const row of result) {
      const d = new Date(row.date).toISOString().split("T")[0];
      const p = (row as Record<string, unknown>).adjClose as number
        ?? row.close;
      if (typeof p === "number" && p > 0) {
        prices[d] = p;
      }
    }
    if (Object.keys(prices).length > 0) {
      console.log(`[performance] yahoo-finance2: ${Object.keys(prices).length} rows for ${ticker}`);
      return prices;
    }
  } catch (e) {
    console.error(
      `[performance] yahoo-finance2 failed for ${ticker}:`,
      e instanceof Error ? e.message : e
    );
  }

  // Fallback to HTTP
  console.log(`[performance] Trying HTTP fallback for ${ticker}`);
  const prices = await fetchHistoricalFallback(ticker, startDate, endDate);
  console.log(`[performance] HTTP fallback: ${Object.keys(prices).length} rows for ${ticker}`);
  return prices;
}

export async function GET(req: NextRequest) {
  const user = req.nextUrl.searchParams.get("user");
  const balStr = req.nextUrl.searchParams.get("balance") || "10000";
  const benchmark = req.nextUrl.searchParams.get("benchmark") || "SPY";
  const period = req.nextUrl.searchParams.get("period") || "ALL";

  if (!user) return NextResponse.json({ error: "user required" }, { status: 400 });
  const initialBalance = Math.max(1, parseFloat(balStr));

  const cacheKey = `${user}_${initialBalance}_${benchmark}`;
  const now = Date.now();

  let fullRows: DailyRow[];

  if (_cache[cacheKey] && now - _cache[cacheKey].ts < CACHE_TTL) {
    fullRows = _cache[cacheKey].data;
  } else {
    const supabase = createServerSupabase();

    const [closedRes, openRes, cmRes] = await Promise.all([
      supabase.from("trades").select("*").eq("username", user).eq("status", "CLOSED"),
      supabase.from("trades").select("*").eq("username", user).eq("status", "OPEN"),
      supabase.from("cash_movements").select("*").eq("username", user),
    ]);

    const closed = (closedRes.data || []) as Record<string, unknown>[];
    const open = (openRes.data || []) as Record<string, unknown>[];
    const cashMovements = (cmRes.data || []) as Record<string, unknown>[];

    const allTrades: Record<string, unknown>[] = [
      ...closed,
      ...open.map((t) => ({ ...t, exit_date: null, exit_price: null })),
    ];

    if (allTrades.length === 0) {
      return NextResponse.json({ rows: [], period, periodLabel: "Sin trades" });
    }

    const tickers = Array.from(new Set(allTrades.map((t) => String(t.symbol))));
    const entryDates = allTrades.map((t) => new Date(String(t.entry_date)));
    const exitDates = allTrades
      .filter((t) => t.exit_date)
      .map((t) => new Date(String(t.exit_date)));
    const cmDates = cashMovements.map((m) => new Date(String(m.movement_date)));

    let startDate = new Date(Math.min(...entryDates.map((d) => d.getTime())));
    let endDate = new Date();
    if (exitDates.length > 0) {
      const maxExit = new Date(Math.max(...exitDates.map((d) => d.getTime())));
      if (maxExit > endDate) endDate = maxExit;
    }
    if (cmDates.length > 0) {
      const minCm = new Date(Math.min(...cmDates.map((d) => d.getTime())));
      const maxCm = new Date(Math.max(...cmDates.map((d) => d.getTime())));
      if (minCm < startDate) startDate = minCm;
      if (maxCm > endDate) endDate = maxCm;
    }

    const endDatePlus = new Date(endDate);
    endDatePlus.setDate(endDatePlus.getDate() + 3);

    // Download historical prices for all tickers + benchmark in parallel
    const priceMap: Record<string, Record<string, number>> = {};
    const allSymbols = [...tickers, benchmark];
    const priceResults = await Promise.all(
      allSymbols.map((sym) => fetchHistorical(sym, startDate, endDatePlus))
    );

    for (let i = 0; i < allSymbols.length; i++) {
      priceMap[allSymbols[i]] = priceResults[i];
    }

    const benchPrices = priceMap[benchmark] || {};
    console.log(
      `[performance] Final counts — tickers: ${tickers.map((t) => `${t}:${Object.keys(priceMap[t] || {}).length}`).join(", ")}, benchmark ${benchmark}: ${Object.keys(benchPrices).length}`
    );

    // Generate business day range
    const allDates: string[] = [];
    const cur = new Date(startDate);
    while (cur <= endDate) {
      const dow = cur.getDay();
      if (dow !== 0 && dow !== 6) {
        allDates.push(cur.toISOString().split("T")[0]);
      }
      cur.setDate(cur.getDate() + 1);
    }

    // Forward-fill prices
    for (const ticker of tickers) {
      let lastPrice = 0;
      for (const d of allDates) {
        if (priceMap[ticker]?.[d] != null) {
          lastPrice = priceMap[ticker][d];
        } else if (lastPrice > 0) {
          if (!priceMap[ticker]) priceMap[ticker] = {};
          priceMap[ticker][d] = lastPrice;
        }
      }
    }

    let lastBench = 0;
    for (const d of allDates) {
      if (benchPrices[d] != null) {
        lastBench = benchPrices[d];
      } else if (lastBench > 0) {
        benchPrices[d] = lastBench;
      }
    }

    // Cash flows from trades
    const tradeFlows: Record<string, number> = {};
    const externalFlows: Record<string, number> = {};

    const snapToBday = (dateStr: string): string => {
      const idx = allDates.indexOf(dateStr);
      if (idx >= 0) return dateStr;
      for (const d of allDates) {
        if (d >= dateStr) return d;
      }
      return allDates[allDates.length - 1];
    };

    for (const trade of allTrades) {
      const entryDate = snapToBday(String(trade.entry_date));
      const cost = Number(trade.quantity) * Number(trade.entry_price);
      const side = String(trade.side);

      if (side === "LONG") {
        tradeFlows[entryDate] = (tradeFlows[entryDate] || 0) - cost;
      } else {
        tradeFlows[entryDate] = (tradeFlows[entryDate] || 0) + cost;
      }

      if (trade.exit_date) {
        const exitDate = snapToBday(String(trade.exit_date));
        const revenue = Number(trade.quantity) * Number(trade.exit_price);
        if (side === "LONG") {
          tradeFlows[exitDate] = (tradeFlows[exitDate] || 0) + revenue;
        } else {
          tradeFlows[exitDate] = (tradeFlows[exitDate] || 0) - revenue;
        }
      }
    }

    for (const cm of cashMovements) {
      const d = snapToBday(String(cm.movement_date));
      const signed =
        cm.movement_type === "APORTE"
          ? Number(cm.amount)
          : -Number(cm.amount);
      externalFlows[d] = (externalFlows[d] || 0) + signed;
    }

    // Build daily series
    let cumCashFlow = initialBalance;
    const cashSeries: number[] = [];
    const extSeries: number[] = [];

    for (const d of allDates) {
      const tf = tradeFlows[d] || 0;
      const ef = externalFlows[d] || 0;
      cumCashFlow += tf + ef;
      cashSeries.push(cumCashFlow);
      extSeries.push(ef);
    }

    // Equity values
    const equityValues: number[] = new Array(allDates.length).fill(0);
    for (const trade of allTrades) {
      const entryDate = String(trade.entry_date);
      const exitDate = trade.exit_date ? String(trade.exit_date) : null;
      const ticker = String(trade.symbol);
      const qty = Number(trade.quantity);
      const entryPrice = Number(trade.entry_price);
      const side = String(trade.side);
      const sign = side === "LONG" ? 1 : -1;

      for (let i = 0; i < allDates.length; i++) {
        const d = allDates[i];
        if (d < entryDate) continue;
        if (exitDate && d >= exitDate) continue;
        const price = priceMap[ticker]?.[d] ?? entryPrice;
        equityValues[i] += sign * qty * price;
      }
    }

    const totalValues = cashSeries.map((c, i) => c + equityValues[i]);

    // TWR
    const dailyReturns: number[] = [];
    for (let i = 0; i < allDates.length; i++) {
      if (i === 0) {
        dailyReturns.push(0);
      } else {
        const prevValue = totalValues[i - 1];
        const ef = extSeries[i];
        if (prevValue > 0) {
          dailyReturns.push((totalValues[i] - ef) / prevValue - 1);
        } else {
          dailyReturns.push(0);
        }
      }
    }

    let cumReturn = 1;
    const cumReturns = dailyReturns.map((r) => {
      cumReturn *= 1 + r;
      return cumReturn - 1;
    });

    // Benchmark returns
    const benchStart = benchPrices[allDates[0]] || 1;
    const spyReturns = allDates.map((d) => {
      const p = benchPrices[d];
      return p ? (p / benchStart - 1) * 100 : 0;
    });

    const spyDrawdown: number[] = [];
    let spyPeak = -Infinity;
    for (const d of allDates) {
      const p = benchPrices[d] || 0;
      if (p > spyPeak) spyPeak = p;
      spyDrawdown.push(spyPeak > 0 ? ((p - spyPeak) / spyPeak) * 100 : 0);
    }

    fullRows = allDates.map((d, i) => ({
      date: d,
      total_value: Math.round(totalValues[i] * 100) / 100,
      cash: Math.round(cashSeries[i] * 100) / 100,
      equity_value: Math.round(equityValues[i] * 100) / 100,
      external_flow: Math.round(extSeries[i] * 100) / 100,
      daily_return: Math.round(dailyReturns[i] * 10000) / 10000,
      cumulative_return: Math.round(cumReturns[i] * 10000) / 10000,
      spy_return: Math.round(spyReturns[i] * 100) / 100,
      spy_drawdown: Math.round(spyDrawdown[i] * 100) / 100,
    }));

    _cache[cacheKey] = { data: fullRows, ts: now };
  }

  // Filter by period
  let rows = fullRows;
  let periodLabel = "Todo el historial";
  const today = new Date();

  if (period === "YTD") {
    const yearStart = `${today.getFullYear()}-01-01`;
    rows = fullRows.filter((r) => r.date >= yearStart);
    periodLabel = `YTD (${today.getFullYear()})`;
  } else if (period === "YOY") {
    const yearAgo = new Date(today);
    yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    const yearAgoStr = yearAgo.toISOString().split("T")[0];
    rows = fullRows.filter((r) => r.date >= yearAgoStr);
    periodLabel = `Último Año`;
  } else if (period === "2025") {
    rows = fullRows.filter((r) => r.date >= "2025-01-01" && r.date <= "2025-12-31");
    periodLabel = "Año 2025";
  }

  // Re-chain TWR for the period slice
  if (rows.length > 0 && period !== "ALL") {
    let cum = 1;
    rows = rows.map((r, i) => {
      const dr = i === 0 ? 0 : r.daily_return;
      cum *= 1 + dr;
      return { ...r, cumulative_return: Math.round((cum - 1) * 10000) / 10000 };
    });

    // Re-normalize benchmark from period start
    const firstSpyRet = rows[0].spy_return;
    if (firstSpyRet !== 0) {
      const spyStart = 1 + firstSpyRet / 100;
      rows = rows.map((r) => ({
        ...r,
        spy_return: Math.round(((1 + r.spy_return / 100) / spyStart - 1) * 10000) / 100,
      }));
    }
  }

  return NextResponse.json({ rows, period, periodLabel });
}
