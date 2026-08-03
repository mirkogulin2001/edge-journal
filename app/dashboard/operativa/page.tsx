"use client";

import { useState, type FormEvent } from "react";
import { useSession } from "@/hooks/useSession";
import { openNewTrade, getOpenTrades } from "@/lib/db/trades";
import { curSym, getStrategyKeys } from "@/lib/calculations/helpers";
import type { Trade, OpenTradeWithMetrics } from "@/types/trade";
import useSWR, { mutate } from "swr";
import KpiCard from "@/components/ui/KpiCard";

function calculateMetrics(trades: Trade[], prices: Record<string, number>): OpenTradeWithMetrics[] {
  return trades.map((t) => {
    const currentPrice = prices[t.symbol] ?? t.entry_price;
    const cost = t.entry_price * t.quantity;
    const unrealizedPnl =
      t.side === "LONG"
        ? (currentPrice - t.entry_price) * t.quantity
        : (t.entry_price - currentPrice) * t.quantity;
    const openRisk =
      t.side === "LONG"
        ? (t.current_stop_loss - t.entry_price) * t.quantity
        : (t.entry_price - t.current_stop_loss) * t.quantity;
    const unrealizedPnlPct = cost > 0 ? (unrealizedPnl / cost) * 100 : 0;
    const openRiskPct = cost > 0 ? (openRisk / cost) * 100 : 0;

    return {
      ...t,
      current_price: Math.round(currentPrice * 100) / 100,
      unrealized_pnl: Math.round(unrealizedPnl * 100) / 100,
      open_risk: Math.round(openRisk * 100) / 100,
      unrealized_pnl_pct: Math.round(unrealizedPnlPct * 100) / 100,
      open_risk_pct: Math.round(openRiskPct * 100) / 100,
    };
  });
}

export default function OperativaPage() {
  const { session } = useSession();
  const user = session?.user;
  const config = session?.config || {};
  const sym = curSym(config);

  // Fetch open trades
  const { data: openTrades = [] } = useSWR(
    user ? `trades-open-${user}` : null,
    () => getOpenTrades(user!)
  );

  // Fetch live prices
  const tickers = Array.from(new Set(openTrades.map((t) => t.symbol)));
  const { data: livePrices = {} } = useSWR(
    tickers.length ? `prices-${tickers.join(",")}` : null,
    async () => {
      const res = await fetch(`/api/prices/live?tickers=${tickers.join(",")}`);
      return res.json();
    },
    { refreshInterval: 30000 }
  );

  const tradesWithMetrics = calculateMetrics(openTrades, livePrices);
  const [pnlMode, setPnlMode] = useState<"$" | "%">("$");

  // New trade form
  const [ticker, setTicker] = useState("");
  const [side, setSide] = useState("LONG");
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  const [sl, setSl] = useState("");
  const [tradeDate, setTradeDate] = useState(new Date().toISOString().split("T")[0]);
  const [notes, setNotes] = useState("");
  const [formMsg, setFormMsg] = useState("");

  async function handleNewTrade(e: FormEvent) {
    e.preventDefault();
    if (!ticker || !qty || !price || !user) return;
    const slVal = sl ? parseFloat(sl) : 0;
    const ok = await openNewTrade(
      user, ticker.toUpperCase(), side, parseFloat(price),
      parseInt(qty), tradeDate, slVal, slVal, {}, notes
    );
    if (ok) {
      setFormMsg("Orden ingresada.");
      setTicker(""); setQty(""); setPrice(""); setSl(""); setNotes("");
      mutate(`trades-open-${user}`);
    } else {
      setFormMsg("Error al crear trade");
    }
  }

  const totalPnl = tradesWithMetrics.reduce((s, t) => s + t.unrealized_pnl, 0);
  const totalRisk = tradesWithMetrics.reduce((s, t) => s + t.open_risk, 0);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left: New trade form */}
      <div className="lg:col-span-5 space-y-4">
        <div className="bg-card border border-border rounded-lg shadow-xl">
          <div className="px-4 py-3 border-b border-border font-bold text-text-main tracking-wide text-sm">
            NUEVA OPERACION
          </div>
          <form onSubmit={handleNewTrade} className="p-4 space-y-3">
            <div className="grid grid-cols-4 gap-3">
              <input placeholder="Ticker" value={ticker} onChange={(e) => setTicker(e.target.value)}
                className="col-span-1 bg-bg border border-border rounded px-3 py-2 text-text-main placeholder-neutral focus:border-accent outline-none transition text-sm" />
              <select value={side} onChange={(e) => setSide(e.target.value)}
                className="col-span-1 bg-bg border border-border rounded px-3 py-2 text-text-main focus:border-accent outline-none transition text-sm">
                <option>LONG</option><option>SHORT</option>
              </select>
              <input placeholder="Qty" type="number" value={qty} onChange={(e) => setQty(e.target.value)}
                className="col-span-1 bg-bg border border-border rounded px-3 py-2 text-text-main placeholder-neutral focus:border-accent outline-none transition text-sm" />
              <input type="date" value={tradeDate} onChange={(e) => setTradeDate(e.target.value)}
                className="col-span-1 bg-bg border border-border rounded px-3 py-2 text-text-main focus:border-accent outline-none transition text-sm" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input placeholder="Precio In" type="number" step="any" value={price} onChange={(e) => setPrice(e.target.value)}
                className="bg-bg border border-border rounded px-3 py-2 text-text-main placeholder-neutral focus:border-accent outline-none transition text-sm" />
              <input placeholder="SL Inicial" type="number" step="any" value={sl} onChange={(e) => setSl(e.target.value)}
                className="bg-bg border border-border rounded px-3 py-2 text-text-main placeholder-neutral focus:border-accent outline-none transition text-sm" />
            </div>
            <textarea placeholder="Notas de entrada..." value={notes} onChange={(e) => setNotes(e.target.value)}
              className="w-full bg-bg border border-border rounded px-3 py-2 text-text-main placeholder-neutral focus:border-accent outline-none transition text-sm h-20 resize-none" />
            <button type="submit"
              className="w-full bg-text-main text-bg font-bold py-3 rounded hover:-translate-y-0.5 active:translate-y-0 transition text-sm">
              EJECUTAR ORDEN
            </button>
            {formMsg && <p className="text-sm text-accent font-semibold">{formMsg}</p>}
          </form>
        </div>
      </div>

      {/* Right: Active positions */}
      <div className="lg:col-span-7 space-y-6">
        {/* Header with toggle */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-wider text-text-main">POSICIONES ACTIVAS</h2>
          <div className="flex border border-border rounded overflow-hidden">
            {(["$", "%"] as const).map((m) => (
              <button key={m} onClick={() => setPnlMode(m)}
                className={`px-3 py-1 text-xs font-bold transition ${pnlMode === m ? "bg-neutral/30 text-text-main" : "text-neutral hover:text-text-main"}`}>
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Positions table */}
        <div className="bg-card border border-border rounded-lg overflow-hidden shadow-xl">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-bg text-neutral uppercase text-xs tracking-wider">
                  <th className="px-3 py-2.5 text-left">Symbol</th>
                  <th className="px-3 py-2.5 text-left">Side</th>
                  <th className="px-3 py-2.5 text-right">Qty</th>
                  <th className="px-3 py-2.5 text-right">In</th>
                  <th className="px-3 py-2.5 text-right">Live</th>
                  <th className="px-3 py-2.5 text-right">{pnlMode === "%" ? "PnL %" : `PnL (${sym})`}</th>
                  <th className="px-3 py-2.5 text-right">{pnlMode === "%" ? "Riesgo %" : `Riesgo (${sym})`}</th>
                  <th className="px-3 py-2.5 text-right">SL Act</th>
                </tr>
              </thead>
              <tbody>
                {tradesWithMetrics.length === 0 ? (
                  <tr><td colSpan={8} className="px-3 py-8 text-center text-neutral">Sin posiciones abiertas</td></tr>
                ) : tradesWithMetrics.map((t, i) => {
                  const pnlVal = pnlMode === "%" ? t.unrealized_pnl_pct : t.unrealized_pnl;
                  const riskVal = pnlMode === "%" ? t.open_risk_pct : t.open_risk;
                  const fmtPnl = pnlMode === "%"
                    ? `${pnlVal.toFixed(2)}%`
                    : `${pnlVal < 0 ? "-" : ""}${sym}${Math.abs(pnlVal).toFixed(2)}`;
                  const fmtRisk = pnlMode === "%"
                    ? `${riskVal.toFixed(2)}%`
                    : `${riskVal < 0 ? "-" : ""}${sym}${Math.abs(riskVal).toFixed(2)}`;

                  return (
                    <tr key={t.id} className={i % 2 === 1 ? "bg-row-odd" : ""}>
                      <td className="px-3 py-2">{t.symbol}</td>
                      <td className={`px-3 py-2 font-semibold ${t.side === "LONG" ? "text-accent" : "text-negative"}`}>{t.side}</td>
                      <td className="px-3 py-2 text-right">{t.quantity}</td>
                      <td className="px-3 py-2 text-right">{sym}{t.entry_price.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-bold">{sym}{t.current_price.toFixed(2)}</td>
                      <td className={`px-3 py-2 text-right font-semibold ${pnlVal >= 0 ? "text-accent" : "text-negative"}`}>{fmtPnl}</td>
                      <td className="px-3 py-2 text-right text-negative">{fmtRisk}</td>
                      <td className="px-3 py-2 text-right font-bold text-text-main">{sym}{t.current_stop_loss.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Exposure summary KPIs */}
        {tradesWithMetrics.length > 0 && (
          <div className="flex gap-3 overflow-x-auto pb-2">
            <KpiCard
              value={`${totalPnl < 0 ? "-" : ""}${sym}${Math.abs(totalPnl).toFixed(0)}`}
              label="PNL NO REALIZADO"
              color={totalPnl >= 0 ? "#00B0BD" : "#F6465D"}
            />
            <KpiCard
              value={`${totalRisk < 0 ? "-" : ""}${sym}${Math.abs(totalRisk).toFixed(0)}`}
              label="RIESGO ACTUAL"
              color="#F6465D"
            />
            <KpiCard value={`${tradesWithMetrics.length}`} label="POSICIONES" />
          </div>
        )}
      </div>
    </div>
  );
}
