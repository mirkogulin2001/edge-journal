import { NextRequest, NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

interface OHLCDay {
  date: string;
  high: number;
  low: number;
}

export interface MfeMaeEntry {
  mfe: number;
  mae: number;
  mfe_r: number | null;
  mae_r: number | null;
  realized_r: number | null;
  efficiency: number | null;
  mfe_pct: number;
  mae_pct: number;
  result_type: string;
  total_pnl: number;
  total_qty: number;
  symbol: string;
  side: string;
}

const _cache: Record<string, { data: Record<string, MfeMaeEntry>; ts: number }> = {};
const CACHE_TTL = 300_000;

async function fetchOHLC(
  ticker: string,
  startDate: Date,
  endDate: Date
): Promise<OHLCDay[]> {
  const s = new Date(startDate);
  s.setDate(s.getDate() - 1);
  const e = new Date(endDate);
  e.setDate(e.getDate() + 2);

  const period1 = Math.floor(s.getTime() / 1000);
  const period2 = Math.floor(e.getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${period1}&period2=${period2}`;

  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return [];
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return [];

    const timestamps: number[] = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const highs: (number | null)[] = quote.high || [];
    const lows: (number | null)[] = quote.low || [];
    const closes: (number | null)[] = quote.close || [];

    const days: OHLCDay[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const d = new Date(timestamps[i] * 1000).toISOString().split("T")[0];
      const h = highs[i] ?? closes[i];
      const l = lows[i] ?? closes[i];
      if (typeof h === "number" && h > 0 && typeof l === "number" && l > 0) {
        days.push({ date: d, high: h, low: l });
      }
    }
    return days;
  } catch {
    return [];
  }
}

export async function GET(request: NextRequest) {
  const username = request.nextUrl.searchParams.get("username");
  if (!username)
    return NextResponse.json({ error: "username required" }, { status: 400 });

  if (_cache[username] && Date.now() - _cache[username].ts < CACHE_TTL) {
    return NextResponse.json(_cache[username].data);
  }

  const supabase = createServerSupabase();
  const { data: trades, error } = await supabase
    .from("trades")
    .select("*")
    .eq("username", username)
    .eq("status", "CLOSED");

  if (error || !trades || trades.length === 0) {
    return NextResponse.json({});
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type TradeRow = any;

  const groups = new Map<string, TradeRow[]>();
  for (const t of trades) {
    const key = `${t.symbol}|${t.entry_price}|${t.entry_date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }

  const symbolRanges: Record<string, { min: string; max: string }> = {};
  const groupKeys = Array.from(groups.keys());
  for (const gk of groupKeys) {
    const group = groups.get(gk)!;
    const sym = group[0].symbol;
    const entryDate = group[0].entry_date;
    const latestExit = group.reduce((latest: string, t: TradeRow) => {
      const d = t.exit_date || "";
      return d > latest ? d : latest;
    }, "");
    if (!symbolRanges[sym]) {
      symbolRanges[sym] = { min: entryDate, max: latestExit };
    } else {
      if (entryDate < symbolRanges[sym].min) symbolRanges[sym].min = entryDate;
      if (latestExit > symbolRanges[sym].max) symbolRanges[sym].max = latestExit;
    }
  }

  const ohlcBySymbol: Record<string, OHLCDay[]> = {};
  await Promise.all(
    Object.entries(symbolRanges).map(async ([sym, range]) => {
      const data = await fetchOHLC(sym, new Date(range.min), new Date(range.max));
      ohlcBySymbol[sym] = data;
    })
  );

  const result: Record<string, MfeMaeEntry> = {};

  for (const key of groupKeys) {
    const group = groups.get(key)!;
    const t0 = group[0];
    const entryDate: string = t0.entry_date;
    const latestExit = group.reduce((latest: string, t: TradeRow) => {
      const d = t.exit_date || "";
      return d > latest ? d : latest;
    }, "");

    const ohlc = ohlcBySymbol[t0.symbol] || [];
    const periodData = ohlc.filter(
      (d) => d.date >= entryDate && d.date <= latestExit
    );
    if (periodData.length === 0) continue;

    const highestHigh = Math.max(...periodData.map((d) => d.high));
    const lowestLow = Math.min(...periodData.map((d) => d.low));
    const entryPrice: number = t0.entry_price;
    const sl: number = t0.initial_stop_loss || 0;
    const side: string = t0.side;

    let mfe: number, mae: number;
    if (side === "LONG") {
      mfe = Math.max(0, highestHigh - entryPrice);
      mae = Math.max(0, entryPrice - lowestLow);
    } else {
      mfe = Math.max(0, entryPrice - lowestLow);
      mae = Math.max(0, highestHigh - entryPrice);
    }

    const totalPnl = group.reduce(
      (s: number, t: TradeRow) => s + (t.pnl ?? 0),
      0
    );
    const totalQty = group.reduce(
      (s: number, t: TradeRow) => s + (t.quantity ?? 0),
      0
    );
    const resultType =
      totalPnl > 0.01 ? "WIN" : totalPnl < -0.01 ? "LOSS" : "BE";

    let oneR = 0;
    if (sl > 0) {
      oneR = side === "LONG" ? entryPrice - sl : sl - entryPrice;
    }

    let mfe_r: number | null = null;
    let mae_r: number | null = null;
    let realized_r: number | null = null;
    let efficiency: number | null = null;

    if (oneR > 0) {
      mfe_r = Math.round((mfe / oneR) * 100) / 100;
      mae_r = Math.round((mae / oneR) * 100) / 100;
      realized_r =
        Math.round((totalPnl / (oneR * totalQty)) * 100) / 100;
      if (mfe_r > 0 && realized_r > 0) {
        efficiency = Math.round((realized_r / mfe_r) * 10000) / 100;
      }
    }

    result[key] = {
      mfe: Math.round(mfe * 100) / 100,
      mae: Math.round(mae * 100) / 100,
      mfe_r,
      mae_r,
      realized_r,
      efficiency,
      mfe_pct: Math.round((mfe / entryPrice) * 10000) / 100,
      mae_pct: Math.round((mae / entryPrice) * 10000) / 100,
      result_type: resultType,
      total_pnl: Math.round(totalPnl * 100) / 100,
      total_qty: totalQty,
      symbol: t0.symbol,
      side,
    };
  }

  _cache[username] = { data: result, ts: Date.now() };
  return NextResponse.json(result);
}
