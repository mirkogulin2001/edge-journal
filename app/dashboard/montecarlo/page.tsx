"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { useSession } from "@/hooks/useSession";
import { getClosedTrades } from "@/lib/db/trades";
import { fmtPct } from "@/lib/calculations/helpers";
import type { Trade } from "@/types/trade";
import useSWR from "swr";
import KpiCard from "@/components/ui/KpiCard";
import PlotlyChart from "@/components/ui/PlotlyChart";

interface MCResult {
  p: number;
  B: number;
  kellyFull: number;
  fUsed: number;
  meanRet: number;
  medRet: number;
  stdRet: number;
  meanDd: number;
  medDd: number;
  p05Dd: number;
  ruinPct: number;
  finalRet: number[];
  maxDd: number[];
  simCurves: number[][];
  medianCurve: number[];
  kellyF: number[];
  kellyG: number[];
}

function runMonteCarlo(
  closed: Trade[],
  nSims: number,
  kellyFraction: number,
  tradesPerSim: number
): MCResult | null {
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
  const avgWinR = winRrs.length > 0 ? winRrs.reduce((s, v) => s + v, 0) / winRrs.length : 0;
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

  // Kelly curve
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

  // Monte Carlo simulation
  const rrPop = rrs.filter((r) => !isNaN(r));
  if (rrPop.length === 0) return null;

  const simCurves: number[][] = [];
  const finalRet: number[] = [];
  const maxDd: number[] = [];

  for (let sim = 0; sim < nSims; sim++) {
    const curve = [1.0];
    let peak = 1.0;
    let worstDd = 0;

    for (let t = 0; t < tradesPerSim; t++) {
      const rr = rrPop[Math.floor(Math.random() * rrPop.length)];
      const next = curve[curve.length - 1] * (1 + rr * fUsed);
      curve.push(next);
      if (next > peak) peak = next;
      const dd = peak > 0 ? (next - peak) / peak : 0;
      if (dd < worstDd) worstDd = dd;
    }

    simCurves.push(curve);
    finalRet.push((curve[curve.length - 1] - 1) * 100);
    maxDd.push(worstDd * 100);
  }

  const ruinCount = simCurves.filter((c) => c.some((v) => v <= 0)).length;
  const ruinPct = (ruinCount / nSims) * 100;

  const meanRet = finalRet.reduce((s, v) => s + v, 0) / finalRet.length;
  const medRet = [...finalRet].sort((a, b) => a - b)[Math.floor(finalRet.length / 2)];
  const variance =
    finalRet.reduce((s, v) => s + (v - meanRet) ** 2, 0) / finalRet.length;
  const stdRet = Math.sqrt(variance);

  const sortedDd = [...maxDd].sort((a, b) => a - b);
  const meanDd = maxDd.reduce((s, v) => s + v, 0) / maxDd.length;
  const medDd = sortedDd[Math.floor(sortedDd.length / 2)];
  const p05Dd = sortedDd[Math.floor(sortedDd.length * 0.05)];

  // Median curve
  const medianCurve: number[] = [];
  const steps = simCurves[0].length;
  for (let t = 0; t < steps; t++) {
    const vals = simCurves.map((c) => c[t]).sort((a, b) => a - b);
    medianCurve.push(vals[Math.floor(vals.length / 2)]);
  }

  return {
    p,
    B,
    kellyFull,
    fUsed,
    meanRet,
    medRet,
    stdRet,
    meanDd,
    medDd,
    p05Dd,
    ruinPct,
    finalRet,
    maxDd,
    simCurves,
    medianCurve,
    kellyF,
    kellyG,
  };
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

export default function MonteCarloPage() {
  const { session } = useSession();
  const user = session?.user;

  const { data: closedTrades = [] } = useSWR(
    user ? `trades-closed-${user}` : null,
    () => getClosedTrades(user!)
  );

  const [nSims, setNSims] = useState(500);
  const [kellyFrac, setKellyFrac] = useState(0.5);
  const [tradesPerSim, setTradesPerSim] = useState(100);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<MCResult | null>(null);

  const [visibleCharts, setVisibleCharts] = useState(0);
  const runIdRef = useRef(0);

  function handleRun() {
    setRunning(true);
    setVisibleCharts(0);
    runIdRef.current++;
    setTimeout(() => {
      const r = runMonteCarlo(closedTrades, nSims, kellyFrac, tradesPerSim);
      setResult(r);
      setRunning(false);
    }, 50);
  }

  useEffect(() => {
    if (!result || running) return;
    const id = ++runIdRef.current;
    setVisibleCharts(0);
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 1; i <= 4; i++) {
      timers.push(setTimeout(() => {
        if (runIdRef.current === id) setVisibleCharts(i);
      }, i * 350));
    }
    return () => timers.forEach(clearTimeout);
  }, [result, running]);

  const mc = result;
  const nShown = mc ? Math.min(50, mc.simCurves.length) : 0;

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
          />
        </div>
        <button
          onClick={handleRun}
          disabled={running || closedTrades.length === 0}
          className="bg-text-main text-bg font-bold px-6 py-2 rounded hover:-translate-y-0.5 transition text-sm disabled:opacity-50"
        >
          {running ? "SIMULANDO..." : "EJECUTAR"}
        </button>
      </div>

      {!mc && !running && (
        <div className="text-center py-16">
          <p className="text-neutral text-sm">
            {closedTrades.length === 0
              ? "Sin trades cerrados — necesitas historial para simular"
              : "Configura los parametros y presiona EJECUTAR"}
          </p>
        </div>
      )}

      {mc && (
        <>
          {/* KPIs */}
          <div className="flex gap-3 overflow-x-auto pb-2">
            <KpiCard
              value={fmtPct(mc.p * 100, 1)}
              label="WIN RATE"
              color="#848E9C"
            />
            <KpiCard
              value={mc.B.toFixed(2)}
              label="RATIO R/B"
              color="#848E9C"
            />
            <KpiCard
              value={fmtPct(mc.kellyFull * 100)}
              label="KELLY OPTIMO"
              color="#00B0BD"
            />
            <KpiCard
              value={fmtPct(mc.fUsed * 100)}
              label={`RIESGO (x${kellyFrac})`}
              color="#00B0BD"
            />
            <KpiCard
              value={fmtPct(mc.meanRet, 1)}
              label="MEDIA RETORNO"
              color="#00B0BD"
            />
            <KpiCard
              value={fmtPct(mc.medRet, 1)}
              label="MEDIANA RETORNO"
              color="#00B0BD"
            />
            <KpiCard
              value={fmtPct(mc.stdRet, 1)}
              label="DESVIO"
              color="#848E9C"
            />
            <KpiCard
              value={fmtPct(mc.p05Dd, 1)}
              label="VAR 95%"
              color="#F6465D"
            />
            <KpiCard
              value={fmtPct(mc.ruinPct, 1)}
              label="RIESGO DE RUINA"
              color="#F6465D"
            />
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Returns distribution */}
            <div className={`transition-all duration-700 ${visibleCharts >= 1 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}>
              <PlotlyChart
                data={[
                  {
                    type: "histogram",
                    x: mc.finalRet,
                    nbinsx: calcBins(mc.finalRet),
                    marker: {
                      color: "#00B0BD",
                      line: { color: "#181A20", width: 1 },
                    },
                    showlegend: false,
                  },
                  {
                    type: "scatter",
                    mode: "lines",
                    x: [mc.meanRet, mc.meanRet],
                    y: [0, nSims * 0.15],
                    name: `Media: ${mc.meanRet.toFixed(1)}%`,
                    line: { color: "#F6465D", dash: "dash", width: 2 },
                  },
                  {
                    type: "scatter",
                    mode: "lines",
                    x: [mc.medRet, mc.medRet],
                    y: [0, nSims * 0.15],
                    name: `Mediana: ${mc.medRet.toFixed(1)}%`,
                    line: { color: "orange", dash: "dot", width: 2 },
                  },
                ]}
                layout={{
                  title: { text: "DISTRIBUCION RETORNOS" },
                  height: 380,
                  xaxis: { ticksuffix: "%" },
                }}
                style={{ height: "380px" }}
              />
            </div>

            {/* Max DD distribution */}
            <div className={`transition-all duration-700 ${visibleCharts >= 2 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}>
              <PlotlyChart
                data={[
                  {
                    type: "histogram",
                    x: mc.maxDd,
                    nbinsx: calcBins(mc.maxDd),
                    marker: {
                      color: "#F6465D",
                      line: { color: "#181A20", width: 1 },
                    },
                    showlegend: false,
                  },
                  {
                    type: "scatter",
                    mode: "lines",
                    x: [mc.meanDd, mc.meanDd],
                    y: [0, nSims * 0.15],
                    name: `Media: ${mc.meanDd.toFixed(1)}%`,
                    line: { color: "#00B0BD", dash: "dash", width: 2 },
                  },
                  {
                    type: "scatter",
                    mode: "lines",
                    x: [mc.medDd, mc.medDd],
                    y: [0, nSims * 0.15],
                    name: `Mediana: ${mc.medDd.toFixed(1)}%`,
                    line: { color: "yellow", dash: "dot", width: 2 },
                  },
                  {
                    type: "scatter",
                    mode: "lines",
                    x: [mc.p05Dd, mc.p05Dd],
                    y: [0, nSims * 0.15],
                    name: `Peor 5%: ${mc.p05Dd.toFixed(1)}%`,
                    line: { color: "cyan", width: 3 },
                  },
                ]}
                layout={{
                  title: { text: "DISTRIBUCION MAX DD" },
                  height: 380,
                  xaxis: { ticksuffix: "%" },
                }}
                style={{ height: "380px" }}
              />
            </div>

            {/* Sim curves */}
            <div className={`transition-all duration-700 ${visibleCharts >= 3 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}>
              <PlotlyChart
                data={[
                  ...mc.simCurves.slice(0, nShown).map((curve) => ({
                    type: "scatter" as const,
                    mode: "lines" as const,
                    y: curve,
                    line: { width: 1 },
                    opacity: 0.15,
                    showlegend: false,
                    hoverinfo: "skip" as const,
                  })),
                  {
                    type: "scatter" as const,
                    mode: "lines" as const,
                    y: mc.medianCurve,
                    name: "Mediana",
                    line: { color: "#848E9C", width: 3 },
                  },
                ]}
                layout={{
                  title: {
                    text: `PROYECCION (LOG) - ${nShown} de ${nSims} curvas`,
                  },
                  height: 380,
                  xaxis: { title: "Trades" },
                  yaxis: { type: "log" },
                }}
                style={{ height: "380px" }}
              />
            </div>

            {/* Kelly curve */}
            <div className={`transition-all duration-700 ${visibleCharts >= 4 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"}`}>
              <PlotlyChart
                data={[
                  {
                    type: "scatter",
                    mode: "lines",
                    x: mc.kellyF,
                    y: mc.kellyG,
                    name: "Curva G(f)",
                    line: { color: "#90A4AE", width: 3 },
                  },
                  ...[0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]
                    .map((m) => {
                      const fp = mc.kellyFull * m;
                      if (fp >= 1 || fp <= 0) return null;
                      const t1 = Math.pow(1 + fp * mc.B, mc.p);
                      const t2 = Math.pow(1 - fp, 1 - mc.p);
                      const gp = (t1 * t2 - 1) * 100;
                      if (gp <= 0.01) return null;
                      return {
                        type: "scatter" as const,
                        mode: "markers+text" as const,
                        x: [fp],
                        y: [gp],
                        name: `${m}x Kelly`,
                        marker: {
                          color: m === 1.0 ? "red" : "#FCD535",
                          size: m === 1.0 ? 12 : 8,
                          symbol: m === 1.0 ? "diamond" : "circle",
                          line: { color: "black", width: 1 },
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
                  xaxis: { title: "Fraccion de Riesgo (f)" },
                  yaxis: {
                    title: "Tasa crecimiento geometrico esperado (%)",
                    ticksuffix: "%",
                  },
                  showlegend: false,
                }}
                style={{ height: "380px" }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
