"use client";

import { useState, useMemo } from "react";
import { useSession } from "@/hooks/useSession";
import { curSym, fmtMoney, fmtMoneySign, fmtPct } from "@/lib/calculations/helpers";
import useSWR from "swr";
import KpiCard from "@/components/ui/KpiCard";
import PlotlyChart from "@/components/ui/PlotlyChart";
import {
  getCashMovements,
  addCashMovement,
  deleteCashMovement,
} from "@/lib/db/cashMovements";
import type { CashMovement } from "@/types/cashMovement";

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

interface PerfResponse {
  rows: DailyRow[];
  period: string;
  periodLabel: string;
}

type Period = "ALL" | "YTD" | "YOY" | "2025";

const BENCHMARK_NAMES: Record<string, string> = {
  SPY: "S&P 500",
  "SPY.BA": "S&P 500 (ARS)",
  QQQ: "Nasdaq 100",
  DIA: "Dow Jones",
};

export default function PerformancePage() {
  const { session } = useSession();
  const user = session?.user;
  const config = session?.config || {};
  const sym = curSym(config);
  const savedBal = (config.initial_balance as number) || 10000;

  const [period, setPeriod] = useState<Period>("YTD");
  const [benchmark, setBenchmark] = useState(
    config.currency === "ARS" ? "SPY.BA" : "SPY"
  );

  // Cash movements
  const [showMovements, setShowMovements] = useState(false);
  const [mvDate, setMvDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [mvAmount, setMvAmount] = useState("");
  const [mvType, setMvType] = useState<"APORTE" | "RETIRO">("APORTE");
  const [mvSaving, setMvSaving] = useState(false);
  const [mvDeleting, setMvDeleting] = useState<number | null>(null);

  const { data: cashMovements = [], mutate: mutateCash } = useSWR<CashMovement[]>(
    user ? `cash-movements-${user}` : null,
    () => getCashMovements(user!)
  );

  const benchName = BENCHMARK_NAMES[benchmark] || benchmark;

  const { data: perfData, isLoading, mutate: mutatePerf } = useSWR<PerfResponse>(
    user
      ? `performance-${user}-${savedBal}-${benchmark}-${period}`
      : null,
    async () => {
      const res = await fetch(
        `/api/performance?user=${user}&balance=${savedBal}&benchmark=${benchmark}&period=${period}`
      );
      return res.json();
    }
  );

  const rows = perfData?.rows || [];
  const periodLabel = perfData?.periodLabel || "";

  const kpis = useMemo(() => {
    if (rows.length === 0) return null;

    const totalEnd = rows[rows.length - 1].total_value;
    const periodStart = rows[0].total_value;
    const totalReturn = rows[rows.length - 1].cumulative_return * 100;
    const totalReturnSpy = rows[rows.length - 1].spy_return;

    const netFlows = rows.slice(1).reduce((s, r) => s + r.external_flow, 0);
    const totalPnl = totalEnd - periodStart - netFlows;

    const totalDeposits = rows.reduce(
      (s, r) => s + (r.external_flow > 0 ? r.external_flow : 0),
      0
    );
    const totalWithdrawals = rows.reduce(
      (s, r) => s + (r.external_flow < 0 ? Math.abs(r.external_flow) : 0),
      0
    );

    // Drawdown on TWR curve
    const twrCurve = rows.map((r) => 1 + r.cumulative_return);
    let twrPeak = -Infinity;
    const drawdowns = twrCurve.map((v) => {
      if (v > twrPeak) twrPeak = v;
      return twrPeak > 0 ? ((v - twrPeak) / twrPeak) * 100 : 0;
    });
    const maxDd = Math.min(...drawdowns);
    const currentDd = drawdowns[drawdowns.length - 1];
    const maxDdSpy = Math.min(...rows.map((r) => r.spy_drawdown));

    // Daily returns for ratios
    const portRets = rows.map((r) => r.daily_return);
    const spyPrices = rows.map((r) => 1 + r.spy_return / 100);
    const spyRets = spyPrices.map((p, i) =>
      i === 0 ? 0 : (p - spyPrices[i - 1]) / spyPrices[i - 1]
    );

    const rfDaily = 0.04 / 252;

    function calcSharpe(rets: number[]): number {
      const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
      const std = Math.sqrt(
        rets.reduce((s, v) => s + (v - mean) ** 2, 0) / rets.length
      );
      return std > 0 ? Math.sqrt(252) * ((mean - rfDaily) / std) : 0;
    }

    function calcSortino(rets: number[]): number {
      const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
      const downside = rets.filter((r) => r < 0);
      if (downside.length < 2) return 0;
      const downStd = Math.sqrt(
        downside.reduce((s, v) => s + v ** 2, 0) / downside.length
      );
      return downStd > 0 ? Math.sqrt(252) * ((mean - rfDaily) / downStd) : 0;
    }

    function calcCalmar(rets: number[], dd: number): number {
      if (dd === 0 || rets.length < 2) return 0;
      const prod = rets.reduce((p, r) => p * (1 + r), 1);
      const annReturn = (Math.pow(prod, 252 / rets.length) - 1) * 100;
      return annReturn / Math.abs(dd);
    }

    const sharpePort = calcSharpe(portRets);
    const sharpeSpy = calcSharpe(spyRets);
    const sortinoPort = calcSortino(portRets);
    const sortinoSpy = calcSortino(spyRets);
    const calmarPort = calcCalmar(portRets, maxDd);
    const calmarSpy = calcCalmar(spyRets, maxDdSpy);

    // Alpha and Beta
    let beta = 1,
      alpha = 0;
    try {
      const n = portRets.length;
      const meanP = portRets.reduce((s, v) => s + v, 0) / n;
      const meanS = spyRets.reduce((s, v) => s + v, 0) / n;
      let cov = 0,
        varS = 0;
      for (let i = 0; i < n; i++) {
        cov += (portRets[i] - meanP) * (spyRets[i] - meanS);
        varS += (spyRets[i] - meanS) ** 2;
      }
      beta = varS > 0 ? cov / varS : 1;
      const rfPeriod = (0.04 * n) / 252;
      alpha =
        (totalReturn / 100 - rfPeriod - beta * (totalReturnSpy / 100 - rfPeriod)) *
        100;
    } catch {}

    // Time Under Water
    let maxTuw = 0,
      avgTuw = 0;
    let currentStreak = 0;
    const streaks: number[] = [];
    for (const dd of drawdowns) {
      if (dd < -0.0001) {
        currentStreak++;
      } else {
        if (currentStreak > 0) streaks.push(currentStreak);
        currentStreak = 0;
      }
    }
    if (currentStreak > 0) streaks.push(currentStreak);
    if (streaks.length > 0) {
      maxTuw = Math.max(...streaks);
      avgTuw = streaks.reduce((s, v) => s + v, 0) / streaks.length;
    }

    return {
      periodStart,
      totalEnd,
      totalReturn,
      totalReturnSpy,
      totalPnl,
      totalDeposits,
      totalWithdrawals,
      maxDd,
      currentDd,
      maxDdSpy,
      sharpePort,
      sharpeSpy,
      sortinoPort,
      sortinoSpy,
      calmarPort,
      calmarSpy,
      alpha,
      beta,
      maxTuw,
      avgTuw,
      drawdowns,
    };
  }, [rows]);

  const periods: { id: Period; label: string }[] = [
    { id: "ALL", label: "TODO" },
    { id: "YTD", label: "YTD" },
    { id: "YOY", label: "1 AÑO" },
    { id: "2025", label: "2025" },
  ];

  if (!user) return null;

  if (rows.length === 0 && !isLoading) {
    return (
      <div className="text-center py-20">
        <h2 className="text-lg font-bold text-text-main tracking-wider mb-2">
          PERFORMANCE
        </h2>
        <p className="text-neutral text-sm">
          Sin datos — registra tus trades en OPERATIVA
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold tracking-wider text-text-main">
            PERFORMANCE
          </h2>
          {isLoading && (
            <span className="text-xs text-neutral animate-pulse">
              Calculando...
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Period buttons */}
          <div className="flex border border-border rounded overflow-hidden">
            {periods.map((p) => (
              <button
                key={p.id}
                onClick={() => setPeriod(p.id)}
                className={`px-3 py-1.5 text-xs font-bold transition ${
                  period === p.id
                    ? "bg-neutral/30 text-text-main"
                    : "text-neutral hover:text-text-main"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {/* Benchmark selector */}
          <select
            value={benchmark}
            onChange={(e) => setBenchmark(e.target.value)}
            className="bg-bg border border-border rounded px-3 py-1.5 text-text-main text-xs focus:border-accent outline-none"
          >
            {Object.entries(BENCHMARK_NAMES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </div>

      {kpis && (
        <>
          {/* KPIs */}
          <div className="flex gap-3 overflow-x-auto pb-2">
            <KpiCard value={fmtMoney(savedBal, sym)} label="CAPITAL INICIAL" />
            <KpiCard
              value={fmtMoney(kpis.periodStart, sym)}
              label="VALOR INICIAL"
              subtitle="Inicio del período"
            />
            {kpis.totalDeposits > 0 && (
              <KpiCard
                value={fmtMoney(kpis.totalDeposits, sym)}
                label="APORTES (PERÍODO)"
                color="#00B0BD"
              />
            )}
            {kpis.totalWithdrawals > 0 && (
              <KpiCard
                value={fmtMoney(kpis.totalWithdrawals, sym)}
                label="RETIROS (PERÍODO)"
                color="#F6465D"
              />
            )}
            <KpiCard
              value={fmtMoneySign(kpis.totalPnl, sym)}
              label="GANANCIA NETA"
              subtitle="Excluye aportes/retiros"
              color={kpis.totalPnl >= 0 ? "#00B0BD" : "#F6465D"}
            />
            <KpiCard
              value={fmtMoney(kpis.totalEnd, sym)}
              label="VALOR FINAL"
              subtitle="Fin del período"
            />
            <KpiCard
              value={`${kpis.totalReturn >= 0 ? "+" : ""}${kpis.totalReturn.toFixed(2)}%`}
              label="RETORNO TOTAL (TWR)"
              subtitle={`${benchName}: ${kpis.totalReturnSpy >= 0 ? "+" : ""}${kpis.totalReturnSpy.toFixed(2)}%`}
              color={kpis.totalReturn >= 0 ? "#00B0BD" : "#F6465D"}
            />
            <KpiCard
              value={fmtPct(kpis.maxDd)}
              label="MAX DRAWDOWN"
              subtitle={`${benchName}: ${kpis.maxDdSpy.toFixed(2)}%`}
              color="#F6465D"
            />
            <KpiCard
              value={kpis.sharpePort.toFixed(2)}
              label="SHARPE"
              subtitle={`${benchName}: ${kpis.sharpeSpy.toFixed(2)}`}
            />
            <KpiCard
              value={kpis.sortinoPort.toFixed(2)}
              label="SORTINO"
              subtitle={`${benchName}: ${kpis.sortinoSpy.toFixed(2)}`}
            />
            <KpiCard
              value={kpis.calmarPort.toFixed(2)}
              label="CALMAR"
              subtitle={`${benchName}: ${kpis.calmarSpy.toFixed(2)}`}
            />
            <KpiCard
              value={`α ${kpis.alpha >= 0 ? "+" : ""}${kpis.alpha.toFixed(2)}%`}
              label="ALPHA (JENSEN)"
              color="#FCD535"
            />
            <KpiCard
              value={`β ${kpis.beta.toFixed(2)}`}
              label="BETA"
              subtitle={`vs ${benchName}`}
            />
            <KpiCard
              value={`${kpis.maxTuw.toFixed(0)} Max`}
              label="TIME UNDER WATER"
              subtitle={`${kpis.avgTuw.toFixed(0)} Promedio (Días)`}
              color={kpis.maxTuw > 0 ? "#F6465D" : "#EAECEF"}
            />
          </div>

          {/* Cash Movements Panel */}
          <div className="bg-card border border-border rounded-lg shadow-xl overflow-hidden">
            <button
              onClick={() => setShowMovements(!showMovements)}
              className="w-full px-4 py-3 flex items-center justify-between text-sm font-bold text-text-main tracking-wide hover:bg-bg/50 transition"
            >
              <span>APORTES Y RETIROS</span>
              <span className="text-neutral text-xs">
                {showMovements ? "▲ CERRAR" : "▼ ABRIR"}
              </span>
            </button>

            {showMovements && (
              <div className="border-t border-border">
                {/* Add form */}
                <div className="px-4 py-3 flex flex-wrap items-end gap-3 border-b border-border">
                  <div>
                    <label className="block text-[0.65rem] text-neutral uppercase tracking-wider font-bold mb-1">
                      FECHA
                    </label>
                    <input
                      type="date"
                      value={mvDate}
                      onChange={(e) => setMvDate(e.target.value)}
                      className="bg-bg border border-border rounded px-3 py-2 text-sm text-text-main focus:border-accent outline-none transition w-[150px]"
                    />
                  </div>
                  <div>
                    <label className="block text-[0.65rem] text-neutral uppercase tracking-wider font-bold mb-1">
                      MONTO
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={mvAmount}
                      onChange={(e) => setMvAmount(e.target.value)}
                      className="bg-bg border border-border rounded px-3 py-2 text-sm text-text-main focus:border-accent outline-none transition w-[130px]"
                    />
                  </div>
                  <div>
                    <label className="block text-[0.65rem] text-neutral uppercase tracking-wider font-bold mb-1">
                      TIPO
                    </label>
                    <select
                      value={mvType}
                      onChange={(e) => setMvType(e.target.value as "APORTE" | "RETIRO")}
                      className="bg-bg border border-border rounded px-3 py-2 text-sm text-text-main focus:border-accent outline-none transition"
                    >
                      <option value="APORTE">APORTE</option>
                      <option value="RETIRO">RETIRO</option>
                    </select>
                  </div>
                  <button
                    disabled={mvSaving || !mvAmount || parseFloat(mvAmount) <= 0}
                    onClick={async () => {
                      setMvSaving(true);
                      const ok = await addCashMovement(
                        user!,
                        mvDate,
                        parseFloat(mvAmount),
                        mvType
                      );
                      if (ok) {
                        setMvAmount("");
                        mutateCash();
                        mutatePerf();
                      }
                      setMvSaving(false);
                    }}
                    className="px-4 py-2 bg-text-main text-bg text-sm font-bold rounded hover:-translate-y-0.5 active:translate-y-0 transition disabled:opacity-50"
                  >
                    {mvSaving ? "GUARDANDO..." : "AGREGAR"}
                  </button>
                </div>

                {/* Movements table */}
                {cashMovements.length === 0 ? (
                  <p className="px-4 py-6 text-center text-neutral text-sm">
                    Sin movimientos registrados
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-bg text-neutral uppercase text-xs tracking-wider">
                          <th className="px-4 py-2.5 text-left">Fecha</th>
                          <th className="px-4 py-2.5 text-left">Tipo</th>
                          <th className="px-4 py-2.5 text-right">Monto</th>
                          <th className="px-4 py-2.5 text-center w-[60px]"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {cashMovements.map((m, i) => (
                          <tr
                            key={m.id}
                            className={i % 2 === 1 ? "bg-row-odd" : ""}
                          >
                            <td className="px-4 py-2 text-text-main">
                              {m.movement_date}
                            </td>
                            <td className="px-4 py-2">
                              <span
                                className="text-xs font-bold px-2 py-0.5 rounded"
                                style={{
                                  color:
                                    m.movement_type === "APORTE"
                                      ? "#00B0BD"
                                      : "#F6465D",
                                  backgroundColor:
                                    m.movement_type === "APORTE"
                                      ? "rgba(0, 176, 189, 0.1)"
                                      : "rgba(246, 70, 93, 0.1)",
                                }}
                              >
                                {m.movement_type}
                              </span>
                            </td>
                            <td
                              className="px-4 py-2 text-right font-semibold"
                              style={{
                                color:
                                  m.movement_type === "APORTE"
                                    ? "#00B0BD"
                                    : "#F6465D",
                              }}
                            >
                              {m.movement_type === "APORTE" ? "+" : "-"}
                              {fmtMoney(m.amount, sym)}
                            </td>
                            <td className="px-4 py-2 text-center">
                              <button
                                disabled={mvDeleting === m.id}
                                onClick={async () => {
                                  setMvDeleting(m.id);
                                  const ok = await deleteCashMovement(m.id);
                                  if (ok) {
                                    mutateCash();
                                    mutatePerf();
                                  }
                                  setMvDeleting(null);
                                }}
                                className="text-neutral hover:text-negative text-xs font-bold transition"
                                title="Eliminar"
                              >
                                {mvDeleting === m.id ? "..." : "✕"}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Charts */}
          <PlotlyChart
            data={[
              {
                type: "scatter",
                mode: "lines",
                x: rows.map((r) => r.date),
                y: rows.map((r) => r.spy_return),
                name: benchName,
                line: { color: "#555555", width: 1.5, dash: "dash", shape: "spline", smoothing: 1.0 },
              },
              {
                type: "scatter",
                mode: "lines",
                x: rows.map((r) => r.date),
                y: rows.map((r) => r.cumulative_return * 100),
                name: "Retorno Acumulado",
                line: { color: "#00B0BD", width: 2.5, shape: "spline", smoothing: 1.0 },
                fill: "tozeroy",
                fillcolor: "rgba(0, 176, 189, 0.06)",
                hovertemplate:
                  "%{x|%Y-%m-%d}<br>Retorno: %{y:.2f}%<extra></extra>",
              },
            ]}
            layout={{
              title: {
                text: `RETORNO ACUMULADO (%) — ${periodLabel}`,
              },
              hovermode: "x unified",
              yaxis: {
                ticksuffix: "%",
              },
              xaxis: { showgrid: false },
              showlegend: false,
              shapes: [
                {
                  type: "line",
                  y0: 0,
                  y1: 0,
                  x0: 0,
                  x1: 1,
                  xref: "paper",
                  line: { color: "rgba(132, 142, 156, 0.4)", width: 1, dash: "dash" },
                },
              ],
              margin: { l: 55, r: 20, t: 36, b: 10 },
            }}
          />

          <PlotlyChart
            data={[
              {
                type: "scatter",
                mode: "lines",
                x: rows.map((r) => r.date),
                y: kpis.drawdowns,
                name: "Drawdown",
                line: { color: "#F6465D", width: 1.5, shape: "spline", smoothing: 1.0 },
                fill: "tozeroy",
                fillcolor: "rgba(246, 70, 93, 0.08)",
                hovertemplate:
                  "%{x|%Y-%m-%d}<br>DD: %{y:.2f}%<extra></extra>",
              },
            ]}
            layout={{
              title: { text: "DRAWDOWN (%)" },
              height: 250,
              hovermode: "x unified",
              yaxis: { ticksuffix: "%" },
              xaxis: { showgrid: false },
              showlegend: false,
              margin: { l: 55, r: 20, t: 36, b: 30 },
            }}
          />
        </>
      )}
    </div>
  );
}
