"use client";

import { useState, useMemo, useCallback, useRef } from "react";
import { useSession } from "@/hooks/useSession";
import { getClosedTrades } from "@/lib/db/trades";
import { fmtPct } from "@/lib/calculations/helpers";
import type { Trade } from "@/types/trade";
import useSWR from "swr";
import KpiCard from "@/components/ui/KpiCard";
import PlotlyChart from "@/components/ui/PlotlyChart";

interface MCSetup {
  p: number;
  q: number;
  B: number;
  kellyFull: number;
  fUsed: number;
  kellyF: number[];
  kellyG: number[];
  rrPop: number[];
}

interface MCProgress {
  setup: MCSetup;
  simCurves: number[][];
  finalRet: number[];
  maxDd: number[];
  completed: number;
  total: number;
}

function computeSetup(
  closed: Trade[],
  kellyFraction: number
): MCSetup | null {
  if (closed.length === 0) return null;

  const cats = closed.map((t) => {
    const rt = t.result_type?.toUpperCase() || "";
    if (["WIN", "LOSS", "BE"].includes(rt)) return rt;
    const r = t.rr ?? 0;
    return r > 0 ? "WIN" : r < 0 ? "LOSS" : "BE";
  });
  const rrs = closed.map((t) => t.rr ?? 0);

  const nWins = cats.filter((c) => c === "WIN").length;
  const nLosses = cats.filter((c) => c === "LOSS").length;
  const active = nWins + nLosses;
  if (active === 0) return null;

  const p = nWins / active;
  const q = 1 - p;

  const winRrs = rrs.filter((_, i) => cats[i] === "WIN");
  const lossRrs = rrs.filter((_, i) => cats[i] === "LOSS");
  const avgWinR =
    winRrs.length > 0 ? winRrs.reduce((s, v) => s + v, 0) / winRrs.length : 0;
  const avgLossR =
    lossRrs.length > 0
      ? Math.abs(lossRrs.reduce((s, v) => s + v, 0) / lossRrs.length)
      : 1;
  const B = avgLossR > 0 ? avgWinR / avgLossR : 0;

  let kellyFull = 0;
  if (B > 0) {
    kellyFull = Math.max(0, (p * (B + 1) - 1) / B);
  }
  const fUsed = kellyFull * kellyFraction;

  const limitSearch = Math.min(0.99, Math.max(0.4, kellyFull * 2.5));
  const kellyF: number[] = [];
  const kellyG: number[] = [];
  for (let i = 0; i <= 300; i++) {
    const f = (i / 300) * limitSearch;
    const t1 = Math.pow(1 + f * B, p);
    const t2 = Math.pow(1 - f, q);
    const g = (t1 * t2 - 1) * 100;
    if (g > 0) {
      kellyF.push(f);
      kellyG.push(g);
    } else if (kellyF.length > 0) {
      kellyF.push(f);
      kellyG.push(0);
      break;
    }
  }

  const rrPop = rrs.filter((r) => !isNaN(r));
  if (rrPop.length === 0) return null;

  return { p, q, B, kellyFull, fUsed, kellyF, kellyG, rrPop };
}

function runBatch(
  setup: MCSetup,
  batchSize: number,
  tradesPerSim: number
): { curves: number[][]; rets: number[]; dds: number[] } {
  const curves: number[][] = [];
  const rets: number[] = [];
  const dds: number[] = [];

  for (let i = 0; i < batchSize; i++) {
    const curve = [1.0];
    let peak = 1.0;
    let worstDd = 0;

    for (let t = 0; t < tradesPerSim; t++) {
      const rr =
        setup.rrPop[Math.floor(Math.random() * setup.rrPop.length)];
      const next = curve[curve.length - 1] * (1 + rr * setup.fUsed);
      curve.push(next);
      if (next > peak) peak = next;
      const dd = peak > 0 ? (next - peak) / peak : 0;
      if (dd < worstDd) worstDd = dd;
    }

    curves.push(curve);
    rets.push((curve[curve.length - 1] - 1) * 100);
    dds.push(worstDd * 100);
  }

  return { curves, rets, dds };
}

function computeStats(progress: MCProgress) {
  const { finalRet, maxDd, simCurves } = progress;
  const n = finalRet.length;
  if (n === 0) return null;

  const meanRet = finalRet.reduce((s, v) => s + v, 0) / n;
  const medRet = [...finalRet].sort((a, b) => a - b)[Math.floor(n / 2)];
  const variance =
    finalRet.reduce((s, v) => s + (v - meanRet) ** 2, 0) / n;
  const stdRet = Math.sqrt(variance);

  const sortedDd = [...maxDd].sort((a, b) => a - b);
  const meanDd = maxDd.reduce((s, v) => s + v, 0) / n;
  const medDd = sortedDd[Math.floor(n / 2)];
  const p05Dd = sortedDd[Math.floor(n * 0.05)];

  const ruinCount = simCurves.filter((c) => c.some((v) => v <= 0)).length;
  const ruinPct = (ruinCount / n) * 100;

  const medianCurve: number[] = [];
  const steps = simCurves[0].length;
  for (let t = 0; t < steps; t++) {
    const vals = simCurves.map((c) => c[t]).sort((a, b) => a - b);
    medianCurve.push(vals[Math.floor(vals.length / 2)]);
  }

  return { meanRet, medRet, stdRet, meanDd, medDd, p05Dd, ruinPct, medianCurve };
}

function calcBins(data: number[]): number {
  if (data.length < 2) return 1;
  const sorted = [...data].sort((a, b) => a - b);
  const n = sorted.length;
  const q1 = sorted[Math.floor(n * 0.25)];
  const q3 = sorted[Math.floor(n * 0.75)];
  const iqr = q3 - q1;
  if (iqr === 0) return Math.ceil(Math.sqrt(n));
  const binWidth = 2 * iqr * Math.pow(n, -1 / 3);
  const range = sorted[n - 1] - sorted[0];
  return Math.max(1, Math.ceil(range / binWidth));
}

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 40;

export default function MonteCarloPage() {
  const { session } = useSession();
  const user = session?.user;

  const { data: closedTrades = [] } = useSWR(
    user ? `trades-closed-${user}` : null,
    () => getClosedTrades(user!)
  );

  const tradingStats = useMemo(() => {
    if (closedTrades.length < 2) return null;
    const dates = closedTrades
      .map((t) => new Date(t.exit_date || "").getTime())
      .filter((d) => !isNaN(d))
      .sort((a, b) => a - b);
    if (dates.length < 2) return null;
    const spanMs = dates[dates.length - 1] - dates[0];
    const spanMonths = Math.max(1, spanMs / (1000 * 60 * 60 * 24 * 30));
    const tradesPerMonth = Math.round(dates.length / spanMonths);
    const suggested3m = Math.max(20, tradesPerMonth * 3);
    const suggested6m = Math.max(30, tradesPerMonth * 6);
    const suggested12m = Math.max(50, tradesPerMonth * 12);
    return { tradesPerMonth, suggested3m, suggested6m, suggested12m };
  }, [closedTrades]);

  const [nSims, setNSims] = useState(500);
  const [kellyFrac, setKellyFrac] = useState(0.5);
  const [tradesPerSim, setTradesPerSim] = useState(100);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<MCProgress | null>(null);

  const runIdRef = useRef(0);

  const warnings = useMemo(() => {
    const w: string[] = [];
    if (closedTrades.length > 0 && closedTrades.length < 30)
      w.push(`Pool chico (${closedTrades.length} trades) — resultados poco confiables`);
    if (tradesPerSim > closedTrades.length * 5 && closedTrades.length > 0)
      w.push("Trades por sim muy alto vs historial — asume que tu edge se mantiene indefinidamente");
    if (tradesPerSim > 300)
      w.push("Más de 300 trades genera retornos compuestos poco realistas");
    if (nSims > 1000)
      w.push("Más de 1000 simulaciones mejora la precisión marginalmente");
    return w;
  }, [closedTrades.length, tradesPerSim, nSims]);

  const handleRun = useCallback(() => {
    const setup = computeSetup(closedTrades, kellyFrac);
    if (!setup) return;

    const id = ++runIdRef.current;
    setRunning(true);

    const acc: MCProgress = {
      setup,
      simCurves: [],
      finalRet: [],
      maxDd: [],
      completed: 0,
      total: nSims,
    };
    setProgress({ ...acc });

    let done = 0;

    function tick() {
      if (runIdRef.current !== id) return;
      const remaining = nSims - done;
      if (remaining <= 0) {
        setRunning(false);
        return;
      }

      const batch = Math.min(BATCH_SIZE, remaining);
      const { curves, rets, dds } = runBatch(setup!, batch, tradesPerSim);

      acc.simCurves = acc.simCurves.concat(curves);
      acc.finalRet = acc.finalRet.concat(rets);
      acc.maxDd = acc.maxDd.concat(dds);
      done += batch;
      acc.completed = done;

      setProgress({ ...acc });

      if (done < nSims) {
        setTimeout(tick, BATCH_DELAY_MS);
      } else {
        setRunning(false);
      }
    }

    setTimeout(tick, 10);
  }, [closedTrades, nSims, kellyFrac, tradesPerSim]);

  const stats = useMemo(
    () => (progress && progress.completed > 0 ? computeStats(progress) : null),
    [progress]
  );

  const mc = progress;
  const s = mc?.setup;
  const pctDone = mc ? Math.round((mc.completed / mc.total) * 100) : 0;

  const displayCurves = useMemo(() => {
    if (!mc || mc.simCurves.length === 0) return [];
    const maxDisplay = 60;
    const all = mc.simCurves;
    if (all.length <= maxDisplay) return all;
    const stride = all.length / maxDisplay;
    const sampled: number[][] = [];
    for (let i = 0; i < maxDisplay; i++) {
      sampled.push(all[Math.floor(i * stride)]);
    }
    return sampled;
  }, [mc]);

  const INPUT =
    "bg-bg border border-border rounded px-3 py-2 text-text-main text-sm focus:border-accent outline-none transition";

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs text-neutral font-bold mb-1">
            SIMULACIONES
          </label>
          <input
            type="number"
            value={nSims}
            onChange={(e) => setNSims(Number(e.target.value))}
            className={`w-28 ${INPUT}`}
            disabled={running}
          />
        </div>
        <div>
          <label className="block text-xs text-neutral font-bold mb-1">
            TRADES POR SIM
          </label>
          <input
            type="number"
            value={tradesPerSim}
            onChange={(e) => setTradesPerSim(Number(e.target.value))}
            className={`w-28 ${INPUT}`}
            disabled={running}
          />
        </div>
        <div>
          <label className="block text-xs text-neutral font-bold mb-1">
            FRACCION KELLY
          </label>
          <input
            type="number"
            step="0.05"
            min="0.05"
            max="2"
            value={kellyFrac}
            onChange={(e) => setKellyFrac(Number(e.target.value))}
            className={`w-28 ${INPUT}`}
            disabled={running}
          />
        </div>
        <button
          onClick={handleRun}
          disabled={running || closedTrades.length === 0}
          className="bg-text-main text-bg font-bold px-6 py-2 rounded hover:-translate-y-0.5 transition text-sm disabled:opacity-50"
        >
          {running ? `SIMULANDO... ${pctDone}%` : "EJECUTAR"}
        </button>
      </div>

      {/* Smart suggestions */}
      {tradingStats && !running && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-neutral">
            Tu ritmo: ~{tradingStats.tradesPerMonth} trades/mes — Proyectar:
          </span>
          {[
            { label: "3 meses", val: tradingStats.suggested3m },
            { label: "6 meses", val: tradingStats.suggested6m },
            { label: "12 meses", val: tradingStats.suggested12m },
          ].map((opt) => (
            <button
              key={opt.label}
              onClick={() => setTradesPerSim(opt.val)}
              className={`px-2.5 py-1 rounded border transition font-bold ${
                tradesPerSim === opt.val
                  ? "border-accent text-accent bg-accent/10"
                  : "border-border text-neutral hover:text-text-main hover:border-neutral"
              }`}
            >
              {opt.label} ({opt.val})
            </button>
          ))}
        </div>
      )}

      {/* Warnings */}
      {warnings.length > 0 && !running && (
        <div className="space-y-1">
          {warnings.map((w, i) => (
            <p key={i} className="text-xs text-yellow-500/80">
              ⚠ {w}
            </p>
          ))}
        </div>
      )}

      {running && (
        <div className="w-full bg-border rounded-full h-1.5 overflow-hidden">
          <div
            className="h-full bg-accent rounded-full transition-all duration-200"
            style={{ width: `${pctDone}%` }}
          />
        </div>
      )}

      {!mc && !running && (
        <div className="text-center py-16">
          <p className="text-neutral text-sm">
            {closedTrades.length === 0
              ? "Sin trades cerrados — necesitas historial para simular"
              : "Configura los parametros y presiona EJECUTAR"}
          </p>
        </div>
      )}

      {mc && s && stats && (
        <>
          {/* KPIs */}
          <div className="flex gap-3 overflow-x-auto pb-2">
            <KpiCard
              value={fmtPct(s.p * 100, 1)}
              label="WIN RATE"
              color="#848E9C"
            />
            <KpiCard
              value={s.B.toFixed(2)}
              label="RATIO R/B"
              color="#848E9C"
            />
            <KpiCard
              value={fmtPct(s.kellyFull * 100)}
              label="KELLY OPTIMO"
              color="#00B0BD"
            />
            <KpiCard
              value={fmtPct(s.fUsed * 100)}
              label={`RIESGO (x${kellyFrac})`}
              color="#00B0BD"
            />
            <KpiCard
              value={fmtPct(stats.meanRet, 1)}
              label="MEDIA RETORNO"
              color="#00B0BD"
            />
            <KpiCard
              value={fmtPct(stats.medRet, 1)}
              label="MEDIANA RETORNO"
              color="#00B0BD"
            />
            <KpiCard
              value={fmtPct(stats.stdRet, 1)}
              label="DESVIO"
              color="#848E9C"
            />
            <KpiCard
              value={fmtPct(stats.p05Dd, 1)}
              label="VAR 95%"
              color="#F6465D"
            />
            <KpiCard
              value={fmtPct(stats.ruinPct, 1)}
              label="RIESGO DE RUINA"
              color="#F6465D"
            />
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Returns distribution */}
            <PlotlyChart
              data={[
                {
                  type: "histogram",
                  x: mc.finalRet,
                  nbinsx: calcBins(mc.finalRet),
                  name: "Retornos",
                  marker: {
                    color: "rgba(0, 176, 189, 0.4)",
                    line: { color: "#00B0BD", width: 1.5 },
                  },
                },
                {
                  type: "scatter",
                  mode: "lines",
                  x: [stats.meanRet, stats.meanRet],
                  y: [0, mc.total * 0.15],
                  name: `Media: ${stats.meanRet.toFixed(1)}%`,
                  line: { color: "#F6465D", dash: "dash", width: 2 },
                },
                {
                  type: "scatter",
                  mode: "lines",
                  x: [stats.medRet, stats.medRet],
                  y: [0, mc.total * 0.15],
                  name: `Mediana: ${stats.medRet.toFixed(1)}%`,
                  line: { color: "orange", dash: "dot", width: 2 },
                },
              ]}
              layout={{
                title: {
                  text: running
                    ? `DISTRIBUCION RETORNOS (${mc.completed}/${mc.total})`
                    : "DISTRIBUCION RETORNOS",
                },
                height: 380,
                showlegend: true,
                legend: { x: 1, xanchor: "right", y: 1, bgcolor: "rgba(24,26,32,0.7)", font: { size: 10 } },
                xaxis: { ticksuffix: "%" },
              }}
              style={{ height: "380px" }}
            />

            {/* Max DD distribution */}
            <PlotlyChart
              data={[
                {
                  type: "histogram",
                  x: mc.maxDd,
                  nbinsx: calcBins(mc.maxDd),
                  name: "Max Drawdown",
                  marker: {
                    color: "rgba(246, 70, 93, 0.4)",
                    line: { color: "#F6465D", width: 1.5 },
                  },
                },
                {
                  type: "scatter",
                  mode: "lines",
                  x: [stats.meanDd, stats.meanDd],
                  y: [0, mc.total * 0.15],
                  name: `Media: ${stats.meanDd.toFixed(1)}%`,
                  line: { color: "#00B0BD", dash: "dash", width: 2 },
                },
                {
                  type: "scatter",
                  mode: "lines",
                  x: [stats.medDd, stats.medDd],
                  y: [0, mc.total * 0.15],
                  name: `Mediana: ${stats.medDd.toFixed(1)}%`,
                  line: { color: "#FCD535", dash: "dot", width: 2 },
                },
                {
                  type: "scatter",
                  mode: "lines",
                  x: [stats.p05Dd, stats.p05Dd],
                  y: [0, mc.total * 0.15],
                  name: `VaR 95%: ${stats.p05Dd.toFixed(1)}%`,
                  line: { color: "cyan", width: 3 },
                },
              ]}
              layout={{
                title: {
                  text: running
                    ? `DISTRIBUCION MAX DD (${mc.completed}/${mc.total})`
                    : "DISTRIBUCION MAX DD",
                },
                height: 380,
                showlegend: true,
                legend: { x: 0, xanchor: "left", y: 1, bgcolor: "rgba(24,26,32,0.7)", font: { size: 10 } },
                xaxis: { ticksuffix: "%" },
              }}
              style={{ height: "380px" }}
            />

            {/* Sim curves */}
            <PlotlyChart
              data={[
                ...displayCurves.map((curve, i) => ({
                  type: "scatter" as const,
                  mode: "lines" as const,
                  y: curve,
                  line: { width: 1, color: "rgba(0, 176, 189, 0.2)" },
                  showlegend: i === 0,
                  name: i === 0 ? "Simulaciones" : undefined,
                  hoverinfo: "skip" as const,
                })),
                {
                  type: "scatter" as const,
                  mode: "lines" as const,
                  y: stats.medianCurve,
                  name: "Mediana",
                  line: { color: "#EAECEF", width: 3 },
                },
              ]}
              layout={{
                title: {
                  text: running
                    ? `PROYECCION (LOG) - ${displayCurves.length} curvas (${mc.completed}/${mc.total})`
                    : `PROYECCION (LOG) - ${displayCurves.length} de ${mc.total} curvas`,
                },
                height: 380,
                showlegend: true,
                legend: { x: 0, xanchor: "left", y: 1, bgcolor: "rgba(24,26,32,0.7)", font: { size: 10 } },
                xaxis: { title: "Trades" },
                yaxis: { type: "log" },
              }}
              style={{ height: "380px" }}
            />

            {/* Kelly curve */}
            <PlotlyChart
              data={[
                {
                  type: "scatter",
                  mode: "lines",
                  x: s.kellyF,
                  y: s.kellyG,
                  name: "G(f)",
                  line: { color: "rgba(144, 164, 174, 0.8)", width: 3 },
                  fill: "tozeroy",
                  fillcolor: "rgba(144, 164, 174, 0.15)",
                },
                ...[0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]
                  .map((m) => {
                    const fp = s.kellyFull * m;
                    if (fp >= 1 || fp <= 0) return null;
                    const t1 = Math.pow(1 + fp * s.B, s.p);
                    const t2 = Math.pow(1 - fp, 1 - s.p);
                    const gp = (t1 * t2 - 1) * 100;
                    if (gp <= 0.01) return null;
                    return {
                      type: "scatter" as const,
                      mode: "markers+text" as const,
                      x: [fp],
                      y: [gp],
                      name: `${m}x Kelly`,
                      marker: {
                        color: m === 1.0 ? "#F6465D" : "rgba(252, 213, 53, 0.8)",
                        size: m === 1.0 ? 12 : 8,
                        symbol: m === 1.0 ? "diamond" : "circle",
                        line: { color: m === 1.0 ? "#F6465D" : "#FCD535", width: 1.5 },
                      },
                      text: [m === 1.0 ? "1.0x (Max)" : `${m}x`],
                      textposition: "top center" as const,
                      textfont: { size: 10, color: "#EAECEF" },
                    };
                  })
                  .filter((v): v is NonNullable<typeof v> => v != null),
              ]}
              layout={{
                title: { text: "CURVA DE CRECIMIENTO VS RIESGO" },
                height: 380,
                showlegend: true,
                legend: { x: 1, xanchor: "right", y: 1, bgcolor: "rgba(24,26,32,0.7)", font: { size: 10 } },
                xaxis: { title: "Fraccion de Riesgo (f)" },
                yaxis: {
                  title: "Tasa crecimiento geometrico (%)",
                  ticksuffix: "%",
                },
              }}
              style={{ height: "380px" }}
            />
          </div>
        </>
      )}
    </div>
  );
}
