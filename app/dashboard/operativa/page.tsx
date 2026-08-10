"use client";

import { useState, type FormEvent } from "react";
import { useSession } from "@/hooks/useSession";
import {
  openNewTrade,
  getOpenTrades,
  getClosedTrades,
  closeTradeTotal,
  closePartial,
  updateStopLoss,
  deleteTrade,
} from "@/lib/db/trades";
import { curSym, fmtMoney2, getStrategyKeys } from "@/lib/calculations/helpers";
import type { Trade, OpenTradeWithMetrics } from "@/types/trade";
import useSWR, { mutate } from "swr";
import KpiCard from "@/components/ui/KpiCard";
import PlotlyChart from "@/components/ui/PlotlyChart";

function calculateMetrics(
  trades: Trade[],
  prices: Record<string, number>
): OpenTradeWithMetrics[] {
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

function fmtVal(v: number, isPct: boolean, sym: string): string {
  if (isPct) return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  return v < 0 ? `-${sym}${Math.abs(v).toFixed(0)}` : `${sym}${v.toFixed(0)}`;
}

type ChartMode = "TOTAL" | "SYMBOL";
type ManagementTab = "close" | "partial" | "sl" | "delete";

export default function OperativaPage() {
  const { session } = useSession();
  const user = session?.user;
  const config = session?.config || {};
  const sym = curSym(config);
  const strategyKeys = getStrategyKeys(config);

  const swrKey = user ? `trades-open-${user}` : null;
  const { data: openTrades = [] } = useSWR(swrKey, () => getOpenTrades(user!));

  const tickers = Array.from(new Set(openTrades.map((t) => t.symbol)));
  const { data: livePrices = {} } = useSWR(
    tickers.length ? `prices-${tickers.join(",")}` : null,
    async () => {
      const res = await fetch(`/api/prices/live?tickers=${tickers.join(",")}`);
      return res.json();
    },
    { refreshInterval: 30000 }
  );

  const { data: closedTrades = [] } = useSWR(
    user ? `trades-closed-${user}` : null,
    () => getClosedTrades(user!)
  );

  const initialBalance = (config.initial_balance as number) || 10000;
  const realizedPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const accountBalance = initialBalance + realizedPnl;

  const tradesWithMetrics = calculateMetrics(openTrades, livePrices);
  const [pnlMode, setPnlMode] = useState<"$" | "%">("$");
  const isPct = pnlMode === "%";

  // New trade form
  const [ticker, setTicker] = useState("");
  const [side, setSide] = useState("LONG");
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  const [sl, setSl] = useState("");
  const [tradeDate, setTradeDate] = useState(
    new Date().toISOString().split("T")[0]
  );
  const [notes, setNotes] = useState("");
  const [formMsg, setFormMsg] = useState("");
  const [tagValues, setTagValues] = useState<Record<string, string>>({});

  // Management panel
  const [selectedTrade, setSelectedTrade] = useState<OpenTradeWithMetrics | null>(null);
  const [mgmtTab, setMgmtTab] = useState<ManagementTab>("close");
  const [closePrice, setClosePrice] = useState("");
  const [closeDate, setCloseDate] = useState(
    new Date().toISOString().split("T")[0]
  );
  const [closeResult, setCloseResult] = useState("WIN");
  const [closeNotes, setCloseNotes] = useState("");
  const [partialQty, setPartialQty] = useState("");
  const [partialPrice, setPartialPrice] = useState("");
  const [partialDate, setPartialDate] = useState(
    new Date().toISOString().split("T")[0]
  );
  const [newSl, setNewSl] = useState("");
  const [mgmtMsg, setMgmtMsg] = useState("");

  // Exposure chart
  const [chartMode, setChartMode] = useState<ChartMode>("TOTAL");

  async function handleNewTrade(e: FormEvent) {
    e.preventDefault();
    if (!ticker || !qty || !price || !user) return;
    const slVal = sl ? parseFloat(sl) : 0;
    const tags: Record<string, string> = {};
    for (const k of strategyKeys) {
      if (tagValues[k]) tags[k] = tagValues[k];
    }
    const ok = await openNewTrade(
      user,
      ticker.toUpperCase(),
      side,
      parseFloat(price),
      parseInt(qty),
      tradeDate,
      slVal,
      slVal,
      tags,
      notes
    );
    if (ok) {
      setFormMsg("Orden ingresada.");
      setTicker("");
      setQty("");
      setPrice("");
      setSl("");
      setNotes("");
      setTagValues({});
      mutate(swrKey);
    } else {
      setFormMsg("Error al crear trade");
    }
  }

  async function handleCloseTotal() {
    if (!selectedTrade || !closePrice) return;
    const ok = await closeTradeTotal(
      selectedTrade.id,
      parseFloat(closePrice),
      closeDate,
      closeResult,
      closeNotes
    );
    if (ok) {
      setMgmtMsg("Posición cerrada.");
      setSelectedTrade(null);
      mutate(swrKey);
    } else {
      setMgmtMsg("Error al cerrar");
    }
  }

  async function handlePartialClose() {
    if (!selectedTrade || !partialQty || !partialPrice) return;
    const result = await closePartial(
      selectedTrade.id,
      parseInt(partialQty),
      parseFloat(partialPrice),
      partialDate
    );
    setMgmtMsg(result.message);
    if (result.ok) {
      setSelectedTrade(null);
      mutate(swrKey);
    }
  }

  async function handleUpdateSl() {
    if (!selectedTrade || !newSl) return;
    const ok = await updateStopLoss(selectedTrade.id, parseFloat(newSl));
    if (ok) {
      setMgmtMsg("SL actualizado.");
      setSelectedTrade(null);
      mutate(swrKey);
    } else {
      setMgmtMsg("Error al actualizar SL");
    }
  }

  async function handleDeleteTrade() {
    if (!selectedTrade) return;
    if (!confirm("¿Eliminar este registro de la base de datos?")) return;
    const ok = await deleteTrade(selectedTrade.id);
    if (ok) {
      setMgmtMsg("Trade eliminado.");
      setSelectedTrade(null);
      mutate(swrKey);
    } else {
      setMgmtMsg("Error al eliminar");
    }
  }

  const totalPnl = tradesWithMetrics.reduce((s, t) => s + t.unrealized_pnl, 0);
  const totalRisk = tradesWithMetrics.reduce((s, t) => s + t.open_risk, 0);
  const totalPnlPctAcct = accountBalance > 0 ? (totalPnl / accountBalance) * 100 : 0;
  const totalRiskPctAcct = accountBalance > 0 ? (totalRisk / accountBalance) * 100 : 0;

  // Build exposure chart data
  function buildExposureChart() {
    if (tradesWithMetrics.length === 0) return { data: [], layout: {} };

    const pnlField = isPct ? "unrealized_pnl_pct" : "unrealized_pnl";
    const riskField = isPct ? "open_risk_pct" : "open_risk";

    const POS_FILL = "rgba(0, 176, 189, 0.4)";
    const POS_LINE = "#00B0BD";
    const NEG_FILL = "rgba(246, 70, 93, 0.4)";
    const NEG_LINE = "#F6465D";
    const RISK_FILL = "rgba(246, 70, 93, 0.15)";

    if (chartMode === "TOTAL") {
      const totalPnlVal = tradesWithMetrics.reduce((s, t) => s + t[pnlField], 0);
      const totalRiskVal = tradesWithMetrics.reduce((s, t) => s + t[riskField], 0);

      return {
        data: [
          {
            type: "bar",
            x: ["PNL NO REALIZADO", "RIESGO ACTUAL"],
            y: [totalPnlVal, totalRiskVal],
            marker: {
              color: [totalPnlVal >= 0 ? POS_FILL : NEG_FILL, RISK_FILL],
              line: {
                color: [totalPnlVal >= 0 ? POS_LINE : NEG_LINE, NEG_LINE],
                width: 1.5,
              },
            },
            text: [
              fmtVal(totalPnlVal, isPct, sym),
              fmtVal(totalRiskVal, isPct, sym),
            ],
            textposition: "outside",
            textfont: { color: "#EAECEF", size: 11 },
            cliponaxis: false,
            hovertemplate: isPct
              ? "%{x}<br>%{y:,.2f}%<extra></extra>"
              : `%{x}<br>${sym}%{y:,.2f}<extra></extra>`,
          },
        ],
        layout: { bargap: 0.45 },
      };
    }

    // POR ACTIVO mode
    const grouped: Record<string, { pnl: number; risk: number }> = {};
    for (const t of tradesWithMetrics) {
      if (!grouped[t.symbol]) grouped[t.symbol] = { pnl: 0, risk: 0 };
      grouped[t.symbol].pnl += t[pnlField];
      grouped[t.symbol].risk += t[riskField];
    }
    const symbols = Object.keys(grouped).sort();
    const pnlValues = symbols.map((s) => grouped[s].pnl);
    const riskValues = symbols.map((s) => grouped[s].risk);

    return {
      data: [
        {
          type: "bar",
          name: "PnL No Realizado",
          x: symbols,
          y: pnlValues,
          marker: {
            color: pnlValues.map((v) => (v >= 0 ? POS_FILL : NEG_FILL)),
            line: {
              color: pnlValues.map((v) => (v >= 0 ? POS_LINE : NEG_LINE)),
              width: 1.5,
            },
          },
          text: pnlValues.map((v) => fmtVal(v, isPct, sym)),
          textposition: "outside",
          textfont: { color: "#EAECEF", size: 11 },
          cliponaxis: false,
          hovertemplate: isPct
            ? "%{x} · PnL: %{y:,.2f}%<extra></extra>"
            : `%{x} · PnL: ${sym}%{y:,.2f}<extra></extra>`,
        },
        {
          type: "bar",
          name: "Riesgo Actual",
          x: symbols,
          y: riskValues,
          marker: {
            color: RISK_FILL,
            line: { color: NEG_LINE, width: 1.5 },
          },
          text: riskValues.map((v) => fmtVal(v, isPct, sym)),
          textposition: "outside",
          textfont: { color: "#EAECEF", size: 11 },
          cliponaxis: false,
          hovertemplate: isPct
            ? "%{x} · Riesgo: %{y:,.2f}%<extra></extra>"
            : `%{x} · Riesgo: ${sym}%{y:,.2f}<extra></extra>`,
        },
      ],
      layout: {
        barmode: "group",
        bargap: 0.3,
        bargroupgap: 0.15,
        showlegend: true,
        legend: {
          orientation: "h",
          yanchor: "bottom",
          y: 1.02,
          xanchor: "right",
          x: 1,
          font: { size: 11, color: "#848E9C" },
        },
      },
    };
  }

  const { data: chartData, layout: chartExtraLayout } = buildExposureChart();

  const tickOpts = isPct
    ? { ticksuffix: "%", tickformat: ",.2f" }
    : { tickprefix: sym, tickformat: ",.0f" };

  const INPUT =
    "bg-bg border border-border rounded px-3 py-2 text-text-main placeholder-neutral focus:border-accent outline-none transition text-sm";

  const mgmtTabs: { id: ManagementTab; label: string }[] = [
    { id: "close", label: "CERRAR" },
    { id: "partial", label: "PARCIAL" },
    { id: "sl", label: "SL" },
    { id: "delete", label: "BORRAR" },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left column: New trade form + Management panel */}
      <div className="lg:col-span-5 space-y-4">
        {/* New trade form */}
        <div className="bg-card border border-border rounded-lg shadow-xl">
          <div className="px-4 py-3 border-b border-border font-bold text-text-main tracking-wide text-sm">
            NUEVA OPERACION
          </div>
          <form onSubmit={handleNewTrade} className="p-4 space-y-3">
            <div className="grid grid-cols-4 gap-3">
              <input
                placeholder="Ticker"
                value={ticker}
                onChange={(e) => setTicker(e.target.value)}
                className={`col-span-1 ${INPUT}`}
              />
              <select
                value={side}
                onChange={(e) => setSide(e.target.value)}
                className={`col-span-1 ${INPUT}`}
              >
                <option>LONG</option>
                <option>SHORT</option>
              </select>
              <input
                placeholder="Qty"
                type="number"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className={`col-span-1 ${INPUT}`}
              />
              <input
                type="date"
                value={tradeDate}
                onChange={(e) => setTradeDate(e.target.value)}
                className={`col-span-1 ${INPUT}`}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input
                placeholder="Precio In"
                type="number"
                step="any"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className={INPUT}
              />
              <input
                placeholder="SL Inicial"
                type="number"
                step="any"
                value={sl}
                onChange={(e) => setSl(e.target.value)}
                className={INPUT}
              />
            </div>
            {strategyKeys.length > 0 && (
              <div className="grid grid-cols-2 gap-3">
                {strategyKeys.map((k) => (
                  <select
                    key={k}
                    value={tagValues[k] || ""}
                    onChange={(e) =>
                      setTagValues((prev) => ({ ...prev, [k]: e.target.value }))
                    }
                    className={INPUT}
                  >
                    <option value="">{k}</option>
                    {(typeof config[k] === "string"
                      ? config[k].split(",")
                      : Array.isArray(config[k])
                        ? (config[k] as string[])
                        : []
                    )
                      .map((v: string) => String(v).trim())
                      .filter(Boolean)
                      .map((v: string) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                  </select>
                ))}
              </div>
            )}
            <textarea
              placeholder="Notas de entrada..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className={`w-full ${INPUT} h-20 resize-none`}
            />
            <button
              type="submit"
              className="w-full bg-text-main text-bg font-bold py-3 rounded hover:-translate-y-0.5 active:translate-y-0 transition text-sm"
            >
              EJECUTAR ORDEN
            </button>
            {!sl && ticker && (
              <p className="text-xs text-negative border border-negative rounded px-2.5 py-1.5 bg-negative/5">
                Sin stop loss definido
              </p>
            )}
            {formMsg && (
              <p className="text-sm text-accent font-semibold">{formMsg}</p>
            )}
          </form>
        </div>

        {/* Management panel — visible when a trade is selected */}
        {selectedTrade && (
          <div className="bg-card border border-border rounded-lg shadow-xl">
            <div className="px-4 py-3 border-b border-border font-bold text-text-main tracking-wide text-sm">
              PANEL DE GESTION DE RIESGO
            </div>
            <div className="p-4 space-y-3">
              <p className="text-sm font-bold text-text-main">
                SELECCION: {selectedTrade.symbol}{" "}
                <span
                  className={
                    selectedTrade.side === "LONG"
                      ? "text-accent"
                      : "text-negative"
                  }
                >
                  {selectedTrade.side}
                </span>{" "}
                x{selectedTrade.quantity} @ {sym}
                {selectedTrade.entry_price.toFixed(2)}
              </p>

              {/* Mini tab bar */}
              <div className="flex border border-border rounded overflow-hidden">
                {mgmtTabs.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setMgmtTab(tab.id)}
                    className={`flex-1 px-2 py-1.5 text-xs font-bold tracking-wider transition ${
                      mgmtTab === tab.id
                        ? "bg-neutral/20 text-text-main"
                        : "text-neutral hover:text-text-main"
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Close total */}
              {mgmtTab === "close" && (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-3">
                    <input
                      placeholder="Precio Salida"
                      type="number"
                      step="any"
                      value={closePrice}
                      onChange={(e) => setClosePrice(e.target.value)}
                      className={INPUT}
                    />
                    <input
                      type="date"
                      value={closeDate}
                      onChange={(e) => setCloseDate(e.target.value)}
                      className={INPUT}
                    />
                    <select
                      value={closeResult}
                      onChange={(e) => setCloseResult(e.target.value)}
                      className={INPUT}
                    >
                      <option>WIN</option>
                      <option>LOSS</option>
                      <option>BE</option>
                    </select>
                  </div>
                  <textarea
                    placeholder="Notas de salida / Lecciones aprendidas..."
                    value={closeNotes}
                    onChange={(e) => setCloseNotes(e.target.value)}
                    className={`w-full ${INPUT} h-20 resize-none`}
                  />
                  <button
                    onClick={handleCloseTotal}
                    className="w-full bg-negative text-white font-bold py-2.5 rounded hover:bg-negative/90 transition text-sm"
                  >
                    LIQUIDAR TOTALIDAD
                  </button>
                </div>
              )}

              {/* Partial close */}
              {mgmtTab === "partial" && (
                <div className="space-y-3">
                  <div className="grid grid-cols-3 gap-3">
                    <input
                      placeholder="Cantidad"
                      type="number"
                      value={partialQty}
                      onChange={(e) => setPartialQty(e.target.value)}
                      className={INPUT}
                    />
                    <input
                      placeholder="Precio Salida"
                      type="number"
                      step="any"
                      value={partialPrice}
                      onChange={(e) => setPartialPrice(e.target.value)}
                      className={INPUT}
                    />
                    <input
                      type="date"
                      value={partialDate}
                      onChange={(e) => setPartialDate(e.target.value)}
                      className={INPUT}
                    />
                  </div>
                  <button
                    onClick={handlePartialClose}
                    className="w-full bg-text-main text-bg font-bold py-2.5 rounded hover:-translate-y-0.5 transition text-sm"
                  >
                    EJECUTAR PARCIAL
                  </button>
                </div>
              )}

              {/* Update SL */}
              {mgmtTab === "sl" && (
                <div className="flex gap-3 items-center">
                  <span className="text-xs text-neutral font-bold whitespace-nowrap">
                    NUEVO SL
                  </span>
                  <input
                    type="number"
                    step="any"
                    value={newSl}
                    onChange={(e) => setNewSl(e.target.value)}
                    className={`flex-1 ${INPUT}`}
                  />
                  <button
                    onClick={handleUpdateSl}
                    className="bg-text-main text-bg font-bold px-4 py-2 rounded text-sm hover:-translate-y-0.5 transition"
                  >
                    ACTUALIZAR
                  </button>
                </div>
              )}

              {/* Delete */}
              {mgmtTab === "delete" && (
                <button
                  onClick={handleDeleteTrade}
                  className="w-full border border-negative text-negative font-bold py-2.5 rounded bg-negative/5 hover:bg-negative/10 transition text-sm"
                >
                  ELIMINAR REGISTRO INDIVIDUAL (DB)
                </button>
              )}

              {mgmtMsg && (
                <p className="text-sm text-accent font-semibold">{mgmtMsg}</p>
              )}

              <button
                onClick={() => {
                  setSelectedTrade(null);
                  setMgmtMsg("");
                }}
                className="w-full text-neutral text-xs hover:text-text-main transition py-1"
              >
                CERRAR PANEL
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Right column: Positions + Chart + KPIs */}
      <div className="lg:col-span-7 space-y-6">
        {/* Header with toggle */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-wider text-text-main">
            POSICIONES ACTIVAS
          </h2>
          <div className="flex border border-border rounded overflow-hidden">
            {(["$", "%"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setPnlMode(m)}
                className={`px-3 py-1 text-xs font-bold transition ${
                  pnlMode === m
                    ? "bg-neutral/30 text-text-main"
                    : "text-neutral hover:text-text-main"
                }`}
              >
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
                  <th className="px-3 py-2.5 text-right">
                    {isPct ? "PnL %" : `PnL (${sym})`}
                  </th>
                  <th className="px-3 py-2.5 text-right">
                    {isPct ? "Riesgo %" : `Riesgo (${sym})`}
                  </th>
                  <th className="px-3 py-2.5 text-right">SL Act</th>
                  {strategyKeys.map((k) => (
                    <th key={k} className="px-3 py-2.5 text-left">
                      {k}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tradesWithMetrics.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8 + strategyKeys.length}
                      className="px-3 py-8 text-center text-neutral"
                    >
                      Sin posiciones abiertas
                    </td>
                  </tr>
                ) : (
                  tradesWithMetrics.map((t, i) => {
                    const pnlVal = isPct ? t.unrealized_pnl_pct : t.unrealized_pnl;
                    const riskVal = isPct ? t.open_risk_pct : t.open_risk;
                    const fmtPnl = isPct
                      ? `${pnlVal.toFixed(2)}%`
                      : fmtMoney2(pnlVal, sym);
                    const fmtRisk = isPct
                      ? `${riskVal.toFixed(2)}%`
                      : fmtMoney2(riskVal, sym);
                    const isSelected = selectedTrade?.id === t.id;

                    return (
                      <tr
                        key={t.id}
                        onClick={() => {
                          setSelectedTrade(isSelected ? null : t);
                          setNewSl(String(t.current_stop_loss));
                          setMgmtMsg("");
                        }}
                        className={`cursor-pointer transition-colors ${
                          isSelected
                            ? "bg-accent/10 border-l-2 border-accent"
                            : i % 2 === 1
                              ? "bg-row-odd hover:bg-neutral/5"
                              : "hover:bg-neutral/5"
                        }`}
                      >
                        <td className="px-3 py-2 font-semibold">{t.symbol}</td>
                        <td
                          className={`px-3 py-2 font-semibold ${
                            t.side === "LONG" ? "text-accent" : "text-negative"
                          }`}
                        >
                          {t.side}
                        </td>
                        <td className="px-3 py-2 text-right">{t.quantity}</td>
                        <td className="px-3 py-2 text-right">
                          {sym}
                          {t.entry_price.toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-right font-bold">
                          {sym}
                          {t.current_price.toFixed(2)}
                        </td>
                        <td
                          className={`px-3 py-2 text-right font-semibold ${
                            pnlVal >= 0 ? "text-accent" : "text-negative"
                          }`}
                        >
                          {fmtPnl}
                        </td>
                        <td className="px-3 py-2 text-right text-negative">
                          {fmtRisk}
                        </td>
                        <td className="px-3 py-2 text-right font-bold text-text-main">
                          {sym}
                          {t.current_stop_loss.toFixed(2)}
                        </td>
                        {strategyKeys.map((k) => (
                          <td key={k} className="px-3 py-2 text-neutral">
                            {t.tags?.[k] || ""}
                          </td>
                        ))}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Exposure summary KPIs */}
        {tradesWithMetrics.length > 0 && (
          <div className="flex gap-3 overflow-x-auto pb-2">
            <KpiCard
              value={isPct ? fmtVal(totalPnlPctAcct, true, sym) : fmtMoney2(totalPnl, sym)}
              label="PNL NO REALIZADO"
              color={totalPnl >= 0 ? "#00B0BD" : "#F6465D"}
            />
            <KpiCard
              value={isPct ? fmtVal(totalRiskPctAcct, true, sym) : fmtMoney2(totalRisk, sym)}
              label="RIESGO ACTUAL"
              color="#F6465D"
            />
            <KpiCard value={`${tradesWithMetrics.length}`} label="POSICIONES" />
          </div>
        )}

        {/* Exposure chart */}
        {tradesWithMetrics.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-neutral tracking-wider">
                EXPOSICION
              </h3>
              <div className="flex border border-border rounded overflow-hidden">
                {(
                  [
                    { value: "TOTAL", label: "TOTAL" },
                    { value: "SYMBOL", label: "POR ACTIVO" },
                  ] as const
                ).map((m) => (
                  <button
                    key={m.value}
                    onClick={() => setChartMode(m.value)}
                    className={`px-3 py-1 text-xs font-bold transition ${
                      chartMode === m.value
                        ? "bg-neutral/30 text-text-main"
                        : "text-neutral hover:text-text-main"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <PlotlyChart
              data={chartData}
              layout={{
                ...chartExtraLayout,
                height: 300,
                yaxis: {
                  showgrid: true,
                  gridcolor: "rgba(43, 49, 57, 0.5)",
                  zerolinecolor: "#2B3139",
                  ...tickOpts,
                },
                xaxis: {
                  showgrid: false,
                  zerolinecolor: "#2B3139",
                  type: "category",
                },
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
