"use client";

import { useState, useMemo } from "react";
import { useSession } from "@/hooks/useSession";
import { getClosedTrades, getOpenTrades } from "@/lib/db/trades";
import { getCashMovements } from "@/lib/db/cashMovements";
import {
  curSym,
  fmtMoney,
  fmtMoney2,
  fmtPct,
  getStrategyKeys,
  RESERVED_CONFIG_KEYS,
} from "@/lib/calculations/helpers";
import type { Trade } from "@/types/trade";
import type { CashMovement } from "@/types/cashMovement";
import useSWR from "swr";
import KpiCard from "@/components/ui/KpiCard";
import PlotlyChart from "@/components/ui/PlotlyChart";

interface AnalyticsData {
  totalPnl: number;
  totalTrades: number;
  nWins: number;
  nLosses: number;
  nBe: number;
  winRate: number;
  lossRate: number;
  ratioMoney: number;
  ratioR: number;
  expAbs: number;
  expMoney: number;
  expR: number;
  maxDd: number;
  currentDd: number;
  maxWinStreak: number;
  maxLossStreak: number;
  tradeNums: number[];
  eqCurve: number[];
  ddCurve: number[];
  cumWinRate: number[];
  cumLossRate: number[];
  cumBeRate: number[];
  cumRatio: number[];
  cumEdge: number[];
  histBins: { bin: string; count: number; cat: string }[];
  strategyBreakdown: Record<
    string,
    { pnl: Record<string, number>; count: Record<string, number> }
  >;
  pieData: { labels: string[]; values: number[] } | null;
}

function computeAnalytics(
  closed: Trade[],
  open: Trade[],
  startBal: number,
  config: Record<string, unknown>,
  cashNetFlows: number
): AnalyticsData | null {
  if (closed.length === 0) return null;

  const sorted = [...closed].sort(
    (a, b) =>
      new Date(a.exit_date || "").getTime() -
      new Date(b.exit_date || "").getTime()
  );

  const pnls = sorted.map((t) => t.pnl ?? 0);
  const rrs = sorted.map((t) => t.rr ?? 0);
  const cats = sorted.map((t) => {
    const rt = t.result_type?.toUpperCase() || "";
    if (rt === "WIN" || rt === "LOSS" || rt === "BE") return rt;
    const p = t.pnl ?? 0;
    return p > 0 ? "WIN" : p < 0 ? "LOSS" : "BE";
  });

  const tradeNums = sorted.map((_, i) => i + 1);
  let cum = 0;
  const cumPnl = pnls.map((p) => (cum += p));
  const eqCurve = cumPnl.map((c) => startBal + c);

  let peak = -Infinity;
  const peaks = eqCurve.map((e) => (peak = Math.max(peak, e)));
  const ddCurve = eqCurve.map((e, i) =>
    peaks[i] > 0 ? ((e - peaks[i]) / peaks[i]) * 100 : 0
  );

  const totalPnl = pnls.reduce((s, p) => s + p, 0);

  let cumWins = 0,
    cumLosses = 0,
    cumBe = 0;
  let cumWinR = 0,
    cumLossR = 0;

  const cumWinRate: number[] = [];
  const cumLossRate: number[] = [];
  const cumBeRate: number[] = [];
  const cumRatio: number[] = [];
  const cumEdge: number[] = [];

  for (let i = 0; i < sorted.length; i++) {
    if (cats[i] === "WIN") {
      cumWins++;
      cumWinR += rrs[i];
    } else if (cats[i] === "LOSS") {
      cumLosses++;
      cumLossR += Math.abs(rrs[i]);
    } else {
      cumBe++;
    }
    const active = cumWins + cumLosses;
    const wr = active > 0 ? (cumWins / active) * 100 : 0;
    const lr = active > 0 ? (cumLosses / active) * 100 : 0;
    const br = i + 1 > 0 ? (cumBe / (i + 1)) * 100 : 0;

    const avgWinR = cumWins > 0 ? cumWinR / cumWins : 0;
    const avgLossR = cumLosses > 0 ? cumLossR / cumLosses : 1;
    const ratio = avgLossR > 0 ? avgWinR / avgLossR : 0;

    cumWinRate.push(wr);
    cumLossRate.push(lr);
    cumBeRate.push(br);
    cumRatio.push(ratio);
    cumEdge.push((wr / 100) * ratio - lr / 100);
  }

  const nWins = cumWins;
  const nLosses = cumLosses;
  const nBe = cumBe;
  const activeTrades = nWins + nLosses;
  const winRate = activeTrades > 0 ? (nWins / activeTrades) * 100 : 0;
  const lossRate = activeTrades > 0 ? (nLosses / activeTrades) * 100 : 0;

  const winPnls = pnls.filter((_, i) => cats[i] === "WIN");
  const lossPnls = pnls.filter((_, i) => cats[i] === "LOSS");
  const winRrs = rrs.filter((_, i) => cats[i] === "WIN");
  const lossRrs = rrs.filter((_, i) => cats[i] === "LOSS");

  const avg = (arr: number[]) =>
    arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
  const avgWin = avg(winPnls);
  const avgLoss = Math.abs(avg(lossPnls));
  const avgWinR = avg(winRrs);
  const avgLossR = Math.abs(avg(lossRrs));

  const ratioMoney = avgLoss > 0 ? avgWin / avgLoss : 0;
  const ratioR = avgLossR > 0 ? avgWinR / avgLossR : 0;
  const expAbs = (winRate / 100) * ratioMoney - lossRate / 100;
  const expMoney = (winRate / 100) * avgWin - (lossRate / 100) * avgLoss;
  const expR = (winRate / 100) * avgWinR - (lossRate / 100) * avgLossR;
  const maxDd = Math.min(...ddCurve);
  const currentDd = ddCurve[ddCurve.length - 1];

  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let curWinStreak = 0;
  let curLossStreak = 0;
  for (const c of cats) {
    if (c === "WIN") {
      curWinStreak++;
      curLossStreak = 0;
      if (curWinStreak > maxWinStreak) maxWinStreak = curWinStreak;
    } else if (c === "LOSS") {
      curLossStreak++;
      curWinStreak = 0;
      if (curLossStreak > maxLossStreak) maxLossStreak = curLossStreak;
    } else {
      curWinStreak = 0;
      curLossStreak = 0;
    }
  }

  function buildHistBins(
    values: number[],
    cat: string
  ): { bin: string; count: number; cat: string }[] {
    if (values.length === 0) return [];
    if (values.length === 1) {
      return [
        {
          bin: `[${values[0].toFixed(2)}, ${values[0].toFixed(2)}]`,
          count: 1,
          cat,
        },
      ];
    }
    const k = Math.ceil(Math.sqrt(values.length));
    const mn = Math.min(...values);
    const mx = Math.max(...values);
    if (mn === mx) {
      return [
        {
          bin: `[${mn.toFixed(2)}, ${mx.toFixed(2)}]`,
          count: values.length,
          cat,
        },
      ];
    }
    const h = (mx - mn) / k;
    const bins: { bin: string; count: number; cat: string }[] = [];
    for (let i = 0; i < k; i++) {
      const lo = mn + i * h;
      const hi = mn + (i + 1) * h;
      const count = values.filter(
        (v) =>
          (i === 0 ? v >= lo : v > lo) && v <= hi + (i === k - 1 ? 1e-9 : 0)
      ).length;
      if (count > 0) {
        bins.push({
          bin: `[${Math.max(mn, lo).toFixed(2)}, ${Math.min(mx, hi).toFixed(2)}]`,
          count,
          cat,
        });
      }
    }
    return bins;
  }

  const histBins = [
    ...buildHistBins(
      pnls.filter((_, i) => cats[i] === "LOSS"),
      "LOSS"
    ),
    ...(nBe > 0 ? [{ bin: "[0.00, 0.00]", count: nBe, cat: "BE" }] : []),
    ...buildHistBins(
      pnls.filter((_, i) => cats[i] === "WIN"),
      "WIN"
    ),
  ];

  const strategyBreakdown: Record<
    string,
    { pnl: Record<string, number>; count: Record<string, number> }
  > = {};
  const stratKeys = Object.keys(config).filter(
    (k) => !RESERVED_CONFIG_KEYS.has(k)
  );
  for (const key of stratKeys) {
    const pnlByVal: Record<string, number> = {};
    const countByVal: Record<string, number> = {};
    for (const t of sorted) {
      const val = t.tags?.[key] || "-";
      pnlByVal[val] = (pnlByVal[val] || 0) + (t.pnl ?? 0);
      countByVal[val] = (countByVal[val] || 0) + 1;
    }
    strategyBreakdown[key] = { pnl: pnlByVal, count: countByVal };
  }

  let pieData: { labels: string[]; values: number[] } | null = null;
  if (open.length > 0) {
    const grouped: Record<string, number> = {};
    for (const t of open) {
      const val = t.entry_price * t.quantity;
      grouped[t.symbol] = (grouped[t.symbol] || 0) + val;
    }
    const lastEq = eqCurve[eqCurve.length - 1];
    const accountValue = lastEq + cashNetFlows;
    const totalInvested = Object.values(grouped).reduce((s, v) => s + v, 0);
    const liq = Math.max(0, accountValue - totalInvested);
    pieData = {
      labels: [...Object.keys(grouped), "Liquidez"],
      values: [...Object.values(grouped), liq],
    };
  }

  return {
    totalPnl,
    totalTrades: sorted.length,
    nWins,
    nLosses,
    nBe,
    winRate,
    lossRate,
    ratioMoney,
    ratioR,
    expAbs,
    expMoney,
    expR,
    maxDd,
    currentDd,
    maxWinStreak,
    maxLossStreak,
    tradeNums,
    eqCurve,
    ddCurve,
    cumWinRate,
    cumLossRate,
    cumBeRate,
    cumRatio,
    cumEdge,
    histBins,
    strategyBreakdown,
    pieData,
  };
}

export default function AnalyticsPage() {
  const { session, updateConfig } = useSession();
  const user = session?.user;
  const config = session?.config || {};
  const sym = curSym(config);
  const strategyKeys = getStrategyKeys(config);

  const savedBal = (config.initial_balance as number) || 10000;
  const [startBal, setStartBal] = useState(savedBal);
  const [selectedMetric, setSelectedMetric] = useState(strategyKeys[0] || "");

  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [filterSymbol, setFilterSymbol] = useState("");
  const [filterSide, setFilterSide] = useState("");
  const [filterStrategy, setFilterStrategy] = useState<Record<string, string>>({});
  const [filtersOpen, setFiltersOpen] = useState(false);

  const { data: closedTrades = [] } = useSWR(
    user ? `trades-closed-${user}` : null,
    () => getClosedTrades(user!)
  );
  const { data: openTrades = [] } = useSWR(
    user ? `trades-open-${user}` : null,
    () => getOpenTrades(user!)
  );
  const { data: cashMovements = [] } = useSWR(
    user ? `cash-movements-${user}` : null,
    () => getCashMovements(user!)
  );

  const symbols = useMemo(
    () => Array.from(new Set(closedTrades.map((t) => t.symbol))).sort(),
    [closedTrades]
  );

  const filteredTrades = useMemo(() => {
    let trades = closedTrades;
    if (filterFrom) {
      const from = new Date(filterFrom).getTime();
      trades = trades.filter(
        (t) => new Date(t.exit_date || "").getTime() >= from
      );
    }
    if (filterTo) {
      const to = new Date(filterTo).getTime() + 86400000;
      trades = trades.filter(
        (t) => new Date(t.exit_date || "").getTime() < to
      );
    }
    if (filterSymbol) {
      trades = trades.filter((t) => t.symbol === filterSymbol);
    }
    if (filterSide) {
      trades = trades.filter((t) => t.side === filterSide);
    }
    for (const [k, v] of Object.entries(filterStrategy)) {
      if (v) trades = trades.filter((t) => t.tags?.[k] === v);
    }
    return trades;
  }, [closedTrades, filterFrom, filterTo, filterSymbol, filterSide, filterStrategy]);

  const hasActiveFilters =
    !!filterFrom || !!filterTo || !!filterSymbol || !!filterSide ||
    Object.values(filterStrategy).some(Boolean);

  const cashNetFlows = cashMovements.reduce(
    (s: number, m: CashMovement) =>
      s + (m.movement_type === "APORTE" ? m.amount : -m.amount),
    0
  );

  const analytics = useMemo(
    () =>
      computeAnalytics(filteredTrades, openTrades, startBal, config, cashNetFlows),
    [filteredTrades, openTrades, startBal, config, cashNetFlows]
  );

  async function handleBalanceChange(val: number) {
    setStartBal(val);
    if (user && val > 0) {
      const newConfig = { ...config, initial_balance: val };
      await updateConfig(newConfig);
    }
  }

  if (!analytics) {
    return (
      <div className="text-center py-20">
        <h2 className="text-lg font-bold text-text-main tracking-wider mb-2">
          METRICAS DE SISTEMA
        </h2>
        <p className="text-neutral text-sm">
          Sin datos — registra tus primeros trades en OPERATIVA
        </p>
      </div>
    );
  }

  const a = analytics;

  function clearFilters() {
    setFilterFrom("");
    setFilterTo("");
    setFilterSymbol("");
    setFilterSide("");
    setFilterStrategy({});
  }

  const INPUT_CLS =
    "bg-bg border border-border rounded px-3 py-1.5 text-text-main text-sm focus:border-accent outline-none";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold tracking-wider text-text-main">
            METRICAS DE SISTEMA
          </h2>
          <button
            onClick={() => setFiltersOpen((o) => !o)}
            className={`text-xs font-bold px-3 py-1 rounded border transition ${
              hasActiveFilters
                ? "border-accent text-accent bg-accent/10"
                : "border-border text-neutral hover:text-text-main"
            }`}
          >
            {filtersOpen ? "OCULTAR FILTROS" : "FILTROS"}
            {hasActiveFilters && ` (${filteredTrades.length}/${closedTrades.length})`}
          </button>
          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              className="text-xs text-negative font-bold hover:text-negative/80 transition"
            >
              LIMPIAR
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral font-bold">
            CAPITAL INICIAL ({sym})
          </span>
          <input
            type="number"
            value={startBal}
            onChange={(e) => handleBalanceChange(Number(e.target.value))}
            className={`w-32 ${INPUT_CLS}`}
          />
        </div>
      </div>

      {filtersOpen && (
        <div className="flex flex-wrap gap-3 p-4 bg-card rounded border border-border">
          <div>
            <label className="block text-[10px] text-neutral font-bold mb-1">DESDE</label>
            <input
              type="date"
              value={filterFrom}
              onChange={(e) => setFilterFrom(e.target.value)}
              className={`w-36 ${INPUT_CLS}`}
            />
          </div>
          <div>
            <label className="block text-[10px] text-neutral font-bold mb-1">HASTA</label>
            <input
              type="date"
              value={filterTo}
              onChange={(e) => setFilterTo(e.target.value)}
              className={`w-36 ${INPUT_CLS}`}
            />
          </div>
          <div>
            <label className="block text-[10px] text-neutral font-bold mb-1">ACTIVO</label>
            <select
              value={filterSymbol}
              onChange={(e) => setFilterSymbol(e.target.value)}
              className={`w-32 ${INPUT_CLS}`}
            >
              <option value="">Todos</option>
              {symbols.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] text-neutral font-bold mb-1">SIDE</label>
            <select
              value={filterSide}
              onChange={(e) => setFilterSide(e.target.value)}
              className={`w-28 ${INPUT_CLS}`}
            >
              <option value="">Todos</option>
              <option value="LONG">LONG</option>
              <option value="SHORT">SHORT</option>
            </select>
          </div>
          {strategyKeys.map((k) => {
            const opts = typeof config[k] === "string"
              ? (config[k] as string).split(",").map((v: string) => v.trim()).filter(Boolean)
              : Array.isArray(config[k])
                ? (config[k] as string[])
                : [];
            return (
              <div key={k}>
                <label className="block text-[10px] text-neutral font-bold mb-1">
                  {k.toUpperCase()}
                </label>
                <select
                  value={filterStrategy[k] || ""}
                  onChange={(e) =>
                    setFilterStrategy((prev) => ({ ...prev, [k]: e.target.value }))
                  }
                  className={`w-32 ${INPUT_CLS}`}
                >
                  <option value="">Todos</option>
                  {opts.map((v: string) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-3 overflow-x-auto pb-2">
        <KpiCard
          value={fmtMoney(a.totalPnl, sym)}
          label="PNL"
          color={a.totalPnl >= 0 ? "#00B0BD" : "#F6465D"}
        />
        <KpiCard value={`${a.totalTrades}`} label="TRADES" />
        <KpiCard value={`${a.nWins}`} label="WINS" color="#00B0BD" />
        <KpiCard value={`${a.nLosses}`} label="LOSSES" color="#F6465D" />
        <KpiCard value={`${a.nBe}`} label="BE" color="#848E9C" />
        <KpiCard value={fmtPct(a.winRate, 1)} label="WIN RATE" />
        <KpiCard value={fmtPct(a.lossRate, 1)} label="LOSS RATE" />
        <KpiCard value={`${a.ratioMoney.toFixed(2)}x`} label="R/R ($) AVG" />
        <KpiCard value={`${a.ratioR.toFixed(2)}x`} label="R/R (RR) AVG" />
        <KpiCard value={a.expAbs.toFixed(2)} label="E(x)" />
        <KpiCard value={fmtMoney2(a.expMoney, sym)} label={`E(x)(${sym})`} />
        <KpiCard value={`${a.expR.toFixed(2)}R`} label="E(x)(RR)" />
        <KpiCard value={fmtPct(a.maxDd)} label="MAX DD" color="#F6465D" />
        <KpiCard
          value={fmtPct(a.currentDd)}
          label="DD ACT"
          color={a.currentDd < 0 ? "#F6465D" : "#00B0BD"}
        />
        <KpiCard value={`${a.maxWinStreak}`} label="MAX RACHA GANADORA" color="#00B0BD" />
        <KpiCard value={`${a.maxLossStreak}`} label="MAX RACHA PERDEDORA" color="#F6465D" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-8 space-y-0">
          <PlotlyChart
            data={[
              {
                type: "scatter",
                mode: "lines",
                x: a.tradeNums,
                y: a.eqCurve,
                line: { color: "#00B0BD", width: 2.5, shape: "spline", smoothing: 1.0 },
                fill: "tozeroy",
                fillcolor: "rgba(0, 176, 189, 0.08)",
                hovertemplate: `Trade %{x}<br>${sym}%{y:,.2f}<extra></extra>`,
              },
            ]}
            layout={{
              title: { text: "CURVA DE EQUITY" },
              height: 350,
              yaxis: {
                tickprefix: sym,
                tickformat: ",.0f",
                range: [
                  Math.min(...a.eqCurve) -
                    (Math.max(...a.eqCurve) - Math.min(...a.eqCurve)) * 0.1,
                  Math.max(...a.eqCurve) +
                    (Math.max(...a.eqCurve) - Math.min(...a.eqCurve)) * 0.1,
                ],
              },
              xaxis: { showgrid: false },
              margin: { t: 36, b: 4, l: 55, r: 20 },
            }}
            style={{ height: "350px" }}
          />
          <PlotlyChart
            data={[
              {
                type: "scatter",
                mode: "lines",
                x: a.tradeNums,
                y: a.ddCurve,
                line: { color: "#F6465D", width: 1.5, shape: "spline", smoothing: 1.0 },
                fill: "tozeroy",
                fillcolor: "rgba(246, 70, 93, 0.08)",
              },
            ]}
            layout={{
              title: { text: "DRAWDOWN (%)" },
              height: 200,
              yaxis: { ticksuffix: "%" },
              xaxis: { showgrid: false },
              margin: { t: 10, b: 20, l: 55, r: 20 },
            }}
            style={{ height: "200px" }}
          />
        </div>
        <div className="lg:col-span-4 space-y-4">
          {a.pieData && (
            <PlotlyChart
              data={[
                {
                  type: "pie",
                  labels: a.pieData.labels,
                  values: a.pieData.values,
                  hole: 0.6,
                  marker: {
                    colors: ["#848E9C", "#00B0BD", "#F6465D", "#FCD535"],
                  },
                },
              ]}
              layout={{
                title: { text: "EXPOSICION" },
                height: 280,
                margin: { t: 40, b: 20, l: 20, r: 20 },
              }}
              style={{ height: "280px" }}
            />
          )}
          <PlotlyChart
            data={
              a.histBins.length > 0
                ? [
                    {
                      type: "bar",
                      x: a.histBins.map((b) => b.bin),
                      y: a.histBins.map((b) => b.count),
                      marker: {
                        color: a.histBins.map((b) =>
                          b.cat === "WIN"
                            ? "rgba(0, 176, 189, 0.4)"
                            : b.cat === "LOSS"
                              ? "rgba(246, 70, 93, 0.4)"
                              : "rgba(132, 142, 156, 0.35)"
                        ),
                        line: {
                          color: a.histBins.map((b) =>
                            b.cat === "WIN"
                              ? "#00B0BD"
                              : b.cat === "LOSS"
                                ? "#F6465D"
                                : "#848E9C"
                          ),
                          width: 1,
                        },
                      },
                      text: a.histBins.map((b) => `${b.count}`),
                      textposition: "outside",
                      textfont: { color: "#EAECEF" },
                    },
                  ]
                : []
            }
            layout={{
              title: { text: "DISTRIBUCION PNL" },
              height: 380,
              bargap: 0.08,
              xaxis: { showgrid: false },
              margin: { t: 36, b: 60, l: 40, r: 20 },
            }}
            style={{ height: "380px" }}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <PlotlyChart
          data={[
            {
              type: "scatter",
              mode: "lines",
              x: a.tradeNums,
              y: a.cumWinRate,
              name: "Win Rate",
              line: { color: "#00B0BD", width: 2, shape: "spline", smoothing: 1.0 },
            },
            {
              type: "scatter",
              mode: "lines",
              x: a.tradeNums,
              y: a.cumLossRate,
              name: "Loss Rate",
              line: { color: "#F6465D", width: 2, shape: "spline", smoothing: 1.0 },
            },
            {
              type: "scatter",
              mode: "lines",
              x: a.tradeNums,
              y: a.cumBeRate,
              name: "BE Rate",
              line: { color: "#848E9C", width: 2, shape: "spline", smoothing: 1.0 },
            },
          ]}
          layout={{
            title: { text: "EVOLUCION TASAS (%)" },
            height: 350,
            yaxis: { ticksuffix: "%" },
            xaxis: { showgrid: false },
            hovermode: "x unified",
            showlegend: true,
            legend: {
              orientation: "h",
              yanchor: "bottom",
              y: 1.02,
              xanchor: "right",
              x: 1,
              font: { size: 11, color: "#848E9C" },
            },
          }}
          style={{ height: "350px" }}
        />
        <PlotlyChart
          data={[
            {
              type: "scatter",
              mode: "lines",
              x: a.tradeNums,
              y: a.cumRatio,
              name: "Ratio R/B",
              line: { color: "#FCD535", width: 2, shape: "spline", smoothing: 1.0 },
              fill: "tozeroy",
              fillcolor: "rgba(252, 213, 53, 0.06)",
            },
          ]}
          layout={{
            title: { text: "EVOLUCION RATIO R/B" },
            height: 350,
            showlegend: false,
            hovermode: "x unified",
            xaxis: { showgrid: false },
          }}
          style={{ height: "350px" }}
        />
        <PlotlyChart
          data={[
            {
              type: "scatter",
              mode: "lines",
              x: a.tradeNums,
              y: a.cumEdge,
              name: "Esperanza",
              line: { color: "#00B0BD", width: 2.5, shape: "spline", smoothing: 1.0 },
              fill: "tozeroy",
              fillcolor: "rgba(0, 176, 189, 0.08)",
              hovertemplate: "Trade %{x}<br>Edge: %{y:.2f}R<extra></extra>",
            },
          ]}
          layout={{
            title: { text: "EVOLUCION DEL EDGE (R)" },
            height: 350,
            showlegend: false,
            hovermode: "x unified",
            xaxis: { showgrid: false },
            yaxis: { ticksuffix: "R" },
            shapes: [
              {
                type: "line",
                y0: 0,
                y1: 0,
                x0: 0,
                x1: 1,
                xref: "paper",
                line: { color: "#F6465D", width: 1.5, dash: "dash" },
              },
            ],
          }}
          style={{ height: "350px" }}
        />
      </div>

      {strategyKeys.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-xs text-neutral font-bold tracking-wider">
              BREAKDOWN POR
            </span>
            <select
              value={selectedMetric}
              onChange={(e) => setSelectedMetric(e.target.value)}
              className="bg-bg border border-border rounded px-3 py-1.5 text-text-main text-sm focus:border-accent outline-none"
            >
              {strategyKeys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>

          {selectedMetric && a.strategyBreakdown[selectedMetric] && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <PlotlyChart
                data={[
                  {
                    type: "bar",
                    x: Object.keys(a.strategyBreakdown[selectedMetric].pnl),
                    y: Object.values(a.strategyBreakdown[selectedMetric].pnl),
                    marker: {
                      color: Object.values(
                        a.strategyBreakdown[selectedMetric].pnl
                      ).map((v) =>
                        v >= 0
                          ? "rgba(0, 176, 189, 0.4)"
                          : "rgba(246, 70, 93, 0.4)"
                      ),
                      line: {
                        color: Object.values(
                          a.strategyBreakdown[selectedMetric].pnl
                        ).map((v) => (v >= 0 ? "#00B0BD" : "#F6465D")),
                        width: 1.5,
                      },
                    },
                    text: Object.values(
                      a.strategyBreakdown[selectedMetric].pnl
                    ).map((v) => fmtMoney(v, sym)),
                    textposition: "outside",
                    textfont: { color: "#EAECEF", size: 11 },
                    cliponaxis: false,
                    hovertemplate: `%{x}<br>${sym}%{y:,.2f}<extra></extra>`,
                  },
                ]}
                layout={{
                  title: { text: `PNL POR ${selectedMetric.toUpperCase()}` },
                  bargap: 0.35,
                  xaxis: { showgrid: false },
                  yaxis: {
                    tickprefix: sym,
                    tickformat: ",.0f",
                  },
                }}
              />
              <PlotlyChart
                data={[
                  {
                    type: "bar",
                    x: Object.keys(
                      a.strategyBreakdown[selectedMetric].count
                    ),
                    y: Object.values(
                      a.strategyBreakdown[selectedMetric].count
                    ),
                    marker: {
                      color: "rgba(132, 142, 156, 0.35)",
                      line: { color: "#848E9C", width: 1.5 },
                    },
                    text: Object.values(
                      a.strategyBreakdown[selectedMetric].count
                    ).map((v) => `${v}`),
                    textposition: "outside",
                    textfont: { color: "#EAECEF", size: 11 },
                    cliponaxis: false,
                    hovertemplate: "%{x}<br>%{y} trades<extra></extra>",
                  },
                ]}
                layout={{
                  title: {
                    text: `TRADES POR ${selectedMetric.toUpperCase()}`,
                  },
                  bargap: 0.35,
                  xaxis: { showgrid: false },
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
