"use client";

import { useState, useMemo, useRef } from "react";
import { useSession } from "@/hooks/useSession";
import { getClosedTrades } from "@/lib/db/trades";
import { fmtPct, curSym, fmtMoney2 } from "@/lib/calculations/helpers";
import type { Trade } from "@/types/trade";
import useSWR from "swr";
import KpiCard from "@/components/ui/KpiCard";
import PlotlyChart from "@/components/ui/PlotlyChart";
import { maxF, meanLogGrowth, optimalFWithDDLimit } from "@/lib/calculations/optimalF";
import { mergePartialCloses } from "@/lib/calculations/mergePartials";

type SizingModel = "KELLY" | "VINCE";

interface GrowthMarker {
  f: number;
  g: number;
  label: string;
  main: boolean;
}

interface MCSetup {
  model: SizingModel;
  p: number;
  q: number;
  B: number;
  fOptimal: number;
  fUsed: number;
  kellyFraction: number;
  ddTarget: number;
  ddAtOptimal: number;
  ddAtFinal: number;
  diluted: boolean;
  growthF: number[];
  growthG: number[];
  markers: GrowthMarker[];
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

function growthCurve(
  limit: number,
  g: (f: number) => number
): { growthF: number[]; growthG: number[] } {
  const growthF: number[] = [];
  const growthG: number[] = [];
  for (let i = 0; i <= 300; i++) {
    const f = (i / 300) * limit;
    const v = g(f);
    if (v > 0) {
      growthF.push(f);
      growthG.push(v);
    } else if (growthF.length > 0) {
      growthF.push(f);
      growthG.push(0);
      break;
    }
  }
  return { growthF, growthG };
}

function computeSetup(
  closed: Trade[],
  model: SizingModel,
  kellyFraction: number,
  ddTarget: number,
  horizon: number
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

  const rrPop = rrs.filter((r) => !isNaN(r));
  if (rrPop.length === 0) return null;

  const base = { model, p, q, B, kellyFraction, ddTarget, rrPop };

  if (model === "VINCE") {
    const res = optimalFWithDDLimit(rrPop, ddTarget, horizon);
    const gVince = (f: number) => (Math.exp(meanLogGrowth(rrPop, f)) - 1) * 100;
    const limit = Math.min(maxF(rrPop) * 0.999, Math.max(res.fOptimal * 2.5, 0.05));
    const markers: GrowthMarker[] = [
      { f: res.fOptimal, g: gVince(res.fOptimal), label: "Optimal f", main: true },
    ];
    if (res.diluted && res.fFinal > 0) {
      markers.push({
        f: res.fFinal,
        g: gVince(res.fFinal),
        label: `f diluido (DD≤${Math.round(ddTarget * 100)}%)`,
        main: false,
      });
    }
    return {
      ...base,
      fOptimal: res.fOptimal,
      fUsed: res.fFinal,
      ddAtOptimal: res.ddAtOptimal,
      ddAtFinal: res.ddAtFinal,
      diluted: res.diluted,
      ...growthCurve(limit, gVince),
      markers: markers.filter((m) => m.g > 0.01),
    };
  }

  let kellyFull = 0;
  if (B > 0) {
    kellyFull = Math.max(0, (p * (B + 1) - 1) / B);
  }
  const gKelly = (f: number) =>
    (Math.pow(1 + f * B, p) * Math.pow(1 - f, q) - 1) * 100;
  const limit = Math.min(0.99, Math.max(0.4, kellyFull * 2.5));
  const markers = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]
    .map((m) => ({ m, f: kellyFull * m }))
    .filter(({ f }) => f > 0 && f < 1)
    .map(({ m, f }) => ({
      f,
      g: gKelly(f),
      label: m === 1.0 ? "1.0x (Max)" : `${m}x`,
      main: m === 1.0,
    }))
    .filter((mk) => mk.g > 0.01);

  return {
    ...base,
    fOptimal: kellyFull,
    fUsed: kellyFull * kellyFraction,
    ddAtOptimal: 0,
    ddAtFinal: 0,
    diluted: false,
    ...growthCurve(limit, gKelly),
    markers,
  };
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
  const config = session?.config || {};
  const initialBalance = (config.initial_balance as number) || 10000;
  const sym = curSym(config);

  const { data: rawClosedTrades } = useSWR(
    user ? `trades-closed-${user}` : null,
    () => getClosedTrades(user!)
  );
  const closedTrades = useMemo(
    () => mergePartialCloses(rawClosedTrades ?? []),
    [rawClosedTrades]
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

  const { data: perfData } = useSWR(
    user ? `perf-balance-${user}-${initialBalance}` : null,
    () =>
      fetch(
        `/api/performance?user=${user}&balance=${initialBalance}&benchmark=SPY&period=ALL`
      ).then((r) => r.json())
  );

  const accountBalance = useMemo(() => {
    if (perfData?.rows?.length > 0) {
      return perfData.rows[perfData.rows.length - 1].total_value as number;
    }
    const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
    return Math.round((initialBalance + totalPnl) * 100) / 100;
  }, [perfData, closedTrades, initialBalance]);

  const [nSims, setNSims] = useState(500);
  const [model, setModel] = useState<SizingModel>("KELLY");
  const [kellyFrac, setKellyFrac] = useState(0.5);
  const [ddTargetPct, setDdTargetPct] = useState(35);
  const [tradesPerSim, setTradesPerSim] = useState(100);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<MCProgress | null>(null);

  const [calcEntry, setCalcEntry] = useState("");
  const [calcStop, setCalcStop] = useState("");

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

  function handleRun() {
    const id = ++runIdRef.current;
    setRunning(true);
    // Defer so the button shows the running state before the (sync) optimal f search.
    setTimeout(() => startRun(id), 10);
  }

  function startRun(id: number) {
    const setup = computeSetup(
      closedTrades,
      model,
      kellyFrac,
      ddTargetPct / 100,
      tradesPerSim
    );
    if (!setup || runIdRef.current !== id) {
      setRunning(false);
      return;
    }

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
  }

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
      {/* Sizing model selector */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-neutral font-bold tracking-wider">
          MODELO DE FRACCION OPTIMA
        </span>
        <div className="flex border border-border rounded overflow-hidden">
          {(
            [
              { value: "KELLY", label: "F DE KELLY" },
              { value: "VINCE", label: "OPTIMAL F (VINCE)" },
            ] as const
          ).map((m) => (
            <button
              key={m.value}
              onClick={() => setModel(m.value)}
              disabled={running}
              className={`px-3 py-1.5 text-xs font-bold transition ${
                model === m.value
                  ? "bg-neutral/30 text-text-main"
                  : "text-neutral hover:text-text-main"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

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
        {model === "KELLY" ? (
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
        ) : (
          <div>
            <label className="block text-xs text-neutral font-bold mb-1">
              DD MAX TOLERADO (VaR 95%)
            </label>
            <div className="relative">
              <input
                type="number"
                step="1"
                min="1"
                max="99"
                value={ddTargetPct}
                onChange={(e) => setDdTargetPct(Number(e.target.value))}
                className={`w-28 pr-7 ${INPUT}`}
                disabled={running}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-neutral">
                %
              </span>
            </div>
          </div>
        )}
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
            {s.model === "KELLY" ? (
              <>
                <KpiCard
                  value={fmtPct(s.fOptimal * 100)}
                  label="KELLY OPTIMO"
                  color="#00B0BD"
                />
                <KpiCard
                  value={fmtPct(s.fUsed * 100)}
                  label={`RIESGO (x${s.kellyFraction})`}
                  color="#00B0BD"
                />
              </>
            ) : (
              <>
                <KpiCard
                  value={fmtPct(s.fOptimal * 100)}
                  label="OPTIMAL F"
                  color="#00B0BD"
                />
                <KpiCard
                  value={fmtPct(s.ddAtOptimal * 100, 1)}
                  label="VAR95 DD @ OPTIMAL F"
                  color="#F6465D"
                />
                <KpiCard
                  value={fmtPct(s.fUsed * 100)}
                  label={s.diluted ? `F DILUIDO (DD≤${Math.round(s.ddTarget * 100)}%)` : "F FINAL (SIN DILUIR)"}
                  color="#00B0BD"
                />
                <KpiCard
                  value={fmtPct(s.ddAtFinal * 100, 1)}
                  label="VAR95 DD @ F FINAL"
                  color="#F6465D"
                />
              </>
            )}
            <KpiCard
              value={fmtMoney2(Math.round(s.fUsed * accountBalance * 100) / 100, sym)}
              label={`RIESGO/TRADE (${sym})`}
              color="#FCD535"
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

          {/* Position calculator */}
          <div className="bg-card border border-border rounded-lg p-4">
            <h3 className="text-xs font-bold text-neutral tracking-wider mb-3">
              CALCULADOR DE POSICIÓN
            </h3>
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <label className="block text-[10px] text-neutral font-bold mb-1">
                  PRECIO ENTRADA
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={calcEntry}
                  onChange={(e) => setCalcEntry(e.target.value)}
                  placeholder="0.00"
                  className="w-32 bg-bg border border-border rounded px-3 py-2 text-text-main text-sm focus:border-accent outline-none"
                />
              </div>
              <div>
                <label className="block text-[10px] text-neutral font-bold mb-1">
                  STOP LOSS
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={calcStop}
                  onChange={(e) => setCalcStop(e.target.value)}
                  placeholder="0.00"
                  className="w-32 bg-bg border border-border rounded px-3 py-2 text-text-main text-sm focus:border-accent outline-none"
                />
              </div>
              {(() => {
                const entry = parseFloat(calcEntry);
                const stop = parseFloat(calcStop);
                const riskPerTrade = s.fUsed * accountBalance;
                const riskPerShare =
                  !isNaN(entry) && !isNaN(stop) && entry > 0 && stop > 0
                    ? Math.abs(entry - stop)
                    : 0;
                const shares =
                  riskPerShare > 0 ? Math.floor(riskPerTrade / riskPerShare) : 0;
                const totalCost = shares * (entry || 0);
                return (
                  <>
                    <div className="bg-bg border border-border rounded px-4 py-2 text-center min-w-[120px]">
                      <p className="text-[10px] text-neutral font-bold mb-0.5">
                        RIESGO/TRADE
                      </p>
                      <p className="text-sm font-bold text-[#FCD535]">
                        {fmtMoney2(
                          Math.round(riskPerTrade * 100) / 100,
                          sym
                        )}
                      </p>
                    </div>
                    <div className="bg-bg border border-border rounded px-4 py-2 text-center min-w-[120px]">
                      <p className="text-[10px] text-neutral font-bold mb-0.5">
                        CANTIDAD
                      </p>
                      <p className="text-sm font-bold text-accent">
                        {shares > 0 ? `${shares} acc` : "—"}
                      </p>
                    </div>
                    {shares > 0 && (
                      <div className="bg-bg border border-border rounded px-4 py-2 text-center min-w-[120px]">
                        <p className="text-[10px] text-neutral font-bold mb-0.5">
                          COSTO TOTAL
                        </p>
                        <p className="text-sm font-bold text-text-main">
                          {fmtMoney2(
                            Math.round(totalCost * 100) / 100,
                            sym
                          )}
                        </p>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
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
                    color: "rgba(0, 176, 189, 0.35)",
                    line: { color: "#00B0BD", width: 1 },
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
                legend: { x: 1, xanchor: "right", y: 1, bgcolor: "rgba(24,26,32,0.6)", font: { size: 10, color: "#848E9C" }, bordercolor: "transparent" },
                xaxis: { ticksuffix: "%", showgrid: false },
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
                    color: "rgba(246, 70, 93, 0.35)",
                    line: { color: "#F6465D", width: 1 },
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
                  line: { color: "cyan", width: 2.5 },
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
                legend: { x: 0, xanchor: "left", y: 1, bgcolor: "rgba(24,26,32,0.6)", font: { size: 10, color: "#848E9C" }, bordercolor: "transparent" },
                xaxis: { ticksuffix: "%", showgrid: false },
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
                legend: { x: 0, xanchor: "left", y: 1, bgcolor: "rgba(24,26,32,0.6)", font: { size: 10, color: "#848E9C" }, bordercolor: "transparent" },
                xaxis: { showgrid: false },
                yaxis: { type: "log" },
              }}
              style={{ height: "380px" }}
            />

            {/* Growth curve (Kelly or Optimal f) */}
            <PlotlyChart
              data={[
                {
                  type: "scatter",
                  mode: "lines",
                  x: s.growthF,
                  y: s.growthG,
                  name: "G(f)",
                  line: { color: "rgba(144, 164, 174, 0.8)", width: 2.5, shape: "spline", smoothing: 1.0 },
                  fill: "tozeroy",
                  fillcolor: "rgba(144, 164, 174, 0.08)",
                },
                ...s.markers.map((mk) => ({
                  type: "scatter" as const,
                  mode: "markers+text" as const,
                  x: [mk.f],
                  y: [mk.g],
                  name: s.model === "KELLY" ? `${mk.label} Kelly` : mk.label,
                  marker: {
                    color: mk.main ? "#F6465D" : "rgba(252, 213, 53, 0.8)",
                    size: mk.main ? 12 : 9,
                    symbol: mk.main ? "diamond" : "circle",
                    line: { color: mk.main ? "#F6465D" : "#FCD535", width: 1.5 },
                  },
                  text: [mk.label],
                  textposition: "top center" as const,
                  textfont: { size: 10, color: "#EAECEF" },
                })),
              ]}
              layout={{
                title: {
                  text:
                    s.model === "KELLY"
                      ? "CURVA DE CRECIMIENTO VS RIESGO (KELLY)"
                      : "CURVA DE CRECIMIENTO VS RIESGO (OPTIMAL F)",
                },
                height: 380,
                showlegend: true,
                legend: { x: 1, xanchor: "right", y: 1, bgcolor: "rgba(24,26,32,0.6)", font: { size: 10, color: "#848E9C" }, bordercolor: "transparent" },
                xaxis: { showgrid: false },
                yaxis: {
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
