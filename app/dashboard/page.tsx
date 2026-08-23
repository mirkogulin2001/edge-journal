"use client";

import { useMemo } from "react";
import { useSession } from "@/hooks/useSession";
import { getClosedTrades, getOpenTrades } from "@/lib/db/trades";
import { curSym, fmtMoney, fmtMoneySign } from "@/lib/calculations/helpers";
import type { Trade } from "@/types/trade";
import useSWR from "swr";
import KpiCard from "@/components/ui/KpiCard";
import PlotlyChart from "@/components/ui/PlotlyChart";

interface MarketQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
  category: string;
}

interface NewsItem {
  id: number;
  headline: string;
  summary: string;
  source: string;
  url: string;
  image: string;
  datetime: number;
  related: string;
}

const COLOR_POS = "#00B0BD";
const COLOR_NEG = "#F6465D";
const COLOR_NEUTRAL = "#848E9C";

function pnlColor(v: number): string {
  if (v > 0) return COLOR_POS;
  if (v < 0) return COLOR_NEG;
  return COLOR_NEUTRAL;
}

function resultColor(r: string | undefined): string {
  if (r === "WIN") return COLOR_POS;
  if (r === "LOSS") return COLOR_NEG;
  return COLOR_NEUTRAL;
}

function isWithinDays(dateStr: string | undefined, days: number): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);
  cutoff.setHours(0, 0, 0, 0);
  return d >= cutoff;
}

function isToday(dateStr: string | undefined): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr).toISOString().split("T")[0];
  const today = new Date().toISOString().split("T")[0];
  return d === today;
}

export default function DashboardHomePage() {
  const { session } = useSession();
  const user = session?.user;
  const config = session?.config || {};
  const sym = curSym(config);
  const initialBalance = (config.initial_balance as number) || 10000;

  // Fetch closed trades
  const { data: closedTrades = [] } = useSWR(
    user ? `home-closed-${user}` : null,
    () => getClosedTrades(user!)
  );

  // Fetch open trades
  const { data: openTrades = [] } = useSWR(
    user ? `home-open-${user}` : null,
    () => getOpenTrades(user!)
  );

  // Fetch live prices for open trades
  const tickers = Array.from(new Set(openTrades.map((t) => t.symbol)));
  const { data: livePrices = {} } = useSWR(
    tickers.length ? `home-prices-${tickers.join(",")}` : null,
    async () => {
      const res = await fetch(`/api/prices/live?tickers=${tickers.join(",")}`);
      return res.json() as Promise<Record<string, number>>;
    },
    { refreshInterval: 30000 }
  );

  // Fetch real account balance from performance API
  const { data: perfData } = useSWR(
    user ? `perf-balance-${user}-${initialBalance}` : null,
    () =>
      fetch(
        `/api/performance?user=${user}&balance=${initialBalance}&benchmark=SPY&period=ALL`
      ).then((r) => r.json())
  );

  // Market feed
  const { data: marketQuotes = [] } = useSWR<MarketQuote[]>(
    "market-feed",
    async () => {
      const res = await fetch("/api/market-feed");
      return res.json();
    },
    { refreshInterval: 60000 }
  );

  // News feed — general + portfolio-specific
  const { data: generalNews = [] } = useSWR<NewsItem[]>(
    "news-general",
    async () => {
      const res = await fetch("/api/news");
      return res.json();
    },
    { refreshInterval: 300000 }
  );

  const { data: portfolioNews = [] } = useSWR<NewsItem[]>(
    tickers.length ? `news-portfolio-${tickers.join(",")}` : null,
    async () => {
      const res = await fetch(`/api/news?tickers=${tickers.join(",")}`);
      return res.json();
    },
    { refreshInterval: 300000 }
  );

  const marketByCategory = useMemo(() => {
    const groups: Record<string, MarketQuote[]> = {};
    for (const q of marketQuotes) {
      if (!groups[q.category]) groups[q.category] = [];
      groups[q.category].push(q);
    }
    return groups;
  }, [marketQuotes]);

  const totalRealizedPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const accountBalance = useMemo(() => {
    if (perfData?.rows?.length > 0) {
      return perfData.rows[perfData.rows.length - 1].total_value as number;
    }
    return initialBalance + totalRealizedPnl;
  }, [perfData, initialBalance, totalRealizedPnl]);

  const pnlToday = closedTrades
    .filter((t) => isToday(t.exit_date))
    .reduce((s, t) => s + (t.pnl ?? 0), 0);

  const pnlWeek = closedTrades
    .filter((t) => isWithinDays(t.exit_date, 7))
    .reduce((s, t) => s + (t.pnl ?? 0), 0);

  const pnlMonth = closedTrades
    .filter((t) => isWithinDays(t.exit_date, 30))
    .reduce((s, t) => s + (t.pnl ?? 0), 0);

  // Unrealized PnL from open positions
  const unrealizedPnl = openTrades.reduce((s, t) => {
    const currentPrice = livePrices[t.symbol] ?? t.entry_price;
    const pnl =
      t.side === "LONG"
        ? (currentPrice - t.entry_price) * t.quantity
        : (t.entry_price - currentPrice) * t.quantity;
    return s + pnl;
  }, 0);

  // Last 5 closed trades (sorted by exit_date desc)
  const last5 = useMemo(() => {
    const sorted = [...closedTrades].sort((a, b) => {
      const da = a.exit_date ?? "";
      const db = b.exit_date ?? "";
      return db.localeCompare(da);
    });
    return sorted.slice(0, 5);
  }, [closedTrades]);

  // Equity curve data from closed trades
  const equityCurve = useMemo(() => {
    if (closedTrades.length === 0) return { x: [] as string[], y: [] as number[] };
    const sorted = [...closedTrades].sort((a, b) => {
      const da = a.exit_date ?? "";
      const db = b.exit_date ?? "";
      return da.localeCompare(db);
    });
    const x: string[] = [];
    const y: number[] = [];
    let cumulative = initialBalance;
    for (const t of sorted) {
      cumulative += t.pnl ?? 0;
      x.push(t.exit_date ?? "");
      y.push(Math.round(cumulative * 100) / 100);
    }
    return { x, y };
  }, [closedTrades, initialBalance]);

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Account Balance */}
      <div className="bg-card border border-border rounded-lg shadow-xl p-6">
        <p className="text-xs text-neutral uppercase tracking-wider font-bold mb-1">
          BALANCE DE CUENTA
        </p>
        <p
          className="text-3xl font-bold tracking-tight"
          style={{ color: accountBalance >= initialBalance ? COLOR_POS : COLOR_NEG }}
        >
          {fmtMoney(accountBalance, sym)}
        </p>
        <p className="text-xs text-neutral mt-1">
          Capital inicial: {fmtMoney(initialBalance, sym)} &middot; PnL realizado:{" "}
          <span style={{ color: pnlColor(totalRealizedPnl) }}>
            {fmtMoneySign(totalRealizedPnl, sym)}
          </span>
        </p>
      </div>

      {/* PnL Summary Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiCard
          value={fmtMoneySign(pnlToday, sym)}
          label="PNL HOY"
          color={pnlColor(pnlToday)}
        />
        <KpiCard
          value={fmtMoneySign(pnlWeek, sym)}
          label="PNL SEMANA"
          color={pnlColor(pnlWeek)}
        />
        <KpiCard
          value={fmtMoneySign(pnlMonth, sym)}
          label="PNL MES"
          color={pnlColor(pnlMonth)}
        />
        <KpiCard
          value={fmtMoneySign(totalRealizedPnl, sym)}
          label="PNL TOTAL"
          color={pnlColor(totalRealizedPnl)}
        />
      </div>

      {/* Open Positions Count */}
      <div className="bg-card border border-border rounded-lg shadow-xl p-4 flex items-center justify-between">
        <div>
          <p className="text-xs text-neutral uppercase tracking-wider font-bold mb-1">
            POSICIONES ABIERTAS
          </p>
          <p className="text-2xl font-bold text-text-main">{openTrades.length}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-neutral uppercase tracking-wider font-bold mb-1">
            PNL NO REALIZADO
          </p>
          <p
            className="text-xl font-bold"
            style={{ color: pnlColor(unrealizedPnl) }}
          >
            {fmtMoneySign(Math.round(unrealizedPnl * 100) / 100, sym)}
          </p>
        </div>
      </div>

      {/* Last 5 Closed Trades */}
      <div className="bg-card border border-border rounded-lg shadow-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border font-bold text-text-main tracking-wide text-sm">
          ULTIMOS CIERRES
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg text-neutral uppercase text-xs tracking-wider">
                <th className="px-3 py-2.5 text-left">Symbol</th>
                <th className="px-3 py-2.5 text-left">Side</th>
                <th className="px-3 py-2.5 text-right">PnL</th>
                <th className="px-3 py-2.5 text-center">Resultado</th>
                <th className="px-3 py-2.5 text-right">Fecha</th>
              </tr>
            </thead>
            <tbody>
              {last5.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-3 py-8 text-center text-neutral">
                    Sin trades cerrados
                  </td>
                </tr>
              ) : (
                last5.map((t, i) => (
                  <tr
                    key={t.id}
                    className={i % 2 === 1 ? "bg-row-odd" : ""}
                  >
                    <td className="px-3 py-2 font-semibold text-text-main">
                      {t.symbol}
                    </td>
                    <td
                      className={`px-3 py-2 font-semibold ${
                        t.side === "LONG" ? "text-accent" : "text-negative"
                      }`}
                    >
                      {t.side}
                    </td>
                    <td
                      className="px-3 py-2 text-right font-semibold"
                      style={{ color: pnlColor(t.pnl ?? 0) }}
                    >
                      {fmtMoneySign(t.pnl ?? 0, sym)}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span
                        className="text-xs font-bold px-2 py-0.5 rounded"
                        style={{
                          color: resultColor(t.result_type),
                          backgroundColor:
                            t.result_type === "WIN"
                              ? "rgba(0, 176, 189, 0.1)"
                              : t.result_type === "LOSS"
                                ? "rgba(246, 70, 93, 0.1)"
                                : "rgba(132, 142, 156, 0.1)",
                        }}
                      >
                        {t.result_type ?? "-"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-neutral">
                      {t.exit_date ?? "-"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mini Equity Curve */}
      {equityCurve.x.length > 1 && (
        <div className="space-y-2">
          <h3 className="text-xs font-bold text-neutral tracking-wider">
            CURVA DE EQUITY
          </h3>
          <PlotlyChart
            data={[
              {
                type: "scatter",
                mode: "lines",
                x: equityCurve.x,
                y: equityCurve.y,
                line: {
                  color: COLOR_POS,
                  width: 2.5,
                  shape: "spline",
                  smoothing: 1.0,
                },
                fill: "tozeroy",
                fillcolor: "rgba(0, 176, 189, 0.06)",
                hovertemplate: `%{x}<br>${sym}%{y:,.0f}<extra></extra>`,
              },
            ]}
            layout={{
              height: 220,
              margin: { l: 50, r: 20, t: 10, b: 30 },
              xaxis: {
                showgrid: false,
              },
              yaxis: {
                tickprefix: sym,
                tickformat: ",.0f",
              },
            }}
          />
        </div>
      )}

      {/* Market Feed */}
      {marketQuotes.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-xs font-bold text-neutral tracking-wider">
            MERCADOS
          </h3>
          {Object.entries(marketByCategory).map(([cat, quotes]) => (
            <div key={cat}>
              <p className="text-[0.65rem] text-neutral uppercase tracking-wider font-bold mb-2">
                {cat}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
                {quotes.map((q) => (
                  <div
                    key={q.symbol}
                    className="bg-card border border-border rounded px-3 py-2.5 hover:border-accent transition"
                  >
                    <p className="text-[0.68rem] text-neutral font-bold truncate">
                      {q.name}
                    </p>
                    <p className="text-sm font-bold text-text-main mt-0.5">
                      {q.price.toLocaleString("en-US", {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </p>
                    <p
                      className="text-xs font-semibold mt-0.5"
                      style={{
                        color: q.changePct > 0 ? COLOR_POS : q.changePct < 0 ? COLOR_NEG : COLOR_NEUTRAL,
                      }}
                    >
                      {q.changePct > 0 ? "+" : ""}
                      {q.changePct.toFixed(2)}%
                      <span className="text-neutral ml-1">
                        ({q.change > 0 ? "+" : ""}
                        {q.change.toFixed(2)})
                      </span>
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* News Feed */}
      {(portfolioNews.length > 0 || generalNews.length > 0) && (
        <div className="space-y-3">
          {/* Portfolio-specific news */}
          {portfolioNews.length > 0 && (
            <>
              <h3 className="text-xs font-bold text-neutral tracking-wider">
                NOTICIAS DE TU PORTFOLIO
              </h3>
              <div className="space-y-2">
                {portfolioNews.slice(0, 8).map((n) => (
                  <a
                    key={n.id}
                    href={n.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block bg-card border border-border rounded-lg p-3 hover:border-accent transition group"
                  >
                    <div className="flex gap-3">
                      {n.image && (
                        <img
                          src={n.image}
                          alt=""
                          className="w-16 h-16 rounded object-cover flex-shrink-0"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = "none";
                          }}
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-text-main group-hover:text-accent transition line-clamp-2">
                          {n.headline}
                        </p>
                        <p className="text-xs text-neutral mt-1 flex items-center gap-2">
                          <span className="font-bold">{n.source}</span>
                          <span>
                            {new Date(n.datetime * 1000).toLocaleDateString("es-AR", {
                              day: "2-digit",
                              month: "short",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                          {n.related && (
                            <span className="text-accent font-semibold">
                              {n.related}
                            </span>
                          )}
                        </p>
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            </>
          )}

          {/* General market news */}
          <h3 className="text-xs font-bold text-neutral tracking-wider">
            NOTICIAS DEL MERCADO
          </h3>
          <div className="space-y-2">
            {generalNews.slice(0, 10).map((n) => (
              <a
                key={n.id}
                href={n.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block bg-card border border-border rounded-lg p-3 hover:border-accent transition group"
              >
                <div className="flex gap-3">
                  {n.image && (
                    <img
                      src={n.image}
                      alt=""
                      className="w-16 h-16 rounded object-cover flex-shrink-0"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-text-main group-hover:text-accent transition line-clamp-2">
                      {n.headline}
                    </p>
                    <p className="text-xs text-neutral mt-1 flex items-center gap-2">
                      <span className="font-bold">{n.source}</span>
                      <span>
                        {new Date(n.datetime * 1000).toLocaleDateString("es-AR", {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </p>
                  </div>
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
