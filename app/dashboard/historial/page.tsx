"use client";

import { useState, useRef, useCallback, useMemo } from "react";
import { useSession } from "@/hooks/useSession";
import {
  getClosedTrades,
  deleteTrade,
  deleteAllClosedTrades,
  openNewTrade,
  closeTradeTotal,
  getOpenTrades,
} from "@/lib/db/trades";
import { curSym, fmtMoney2, getStrategyKeys } from "@/lib/calculations/helpers";
import type { Trade, ClosedTradeWithPct } from "@/types/trade";
import useSWR from "swr";

interface MergedTrade extends ClosedTradeWithPct {
  closes_count: number;
  child_trades: ClosedTradeWithPct[];
  child_ids: number[];
}

function addPnlPct(trades: Trade[]): ClosedTradeWithPct[] {
  return trades.map((t) => {
    const cost = t.entry_price * t.quantity;
    const pnlPct = cost > 0 && t.pnl != null ? (t.pnl / cost) * 100 : 0;
    return { ...t, pnl_pct: Math.round(pnlPct * 100) / 100 };
  });
}

function groupKey(t: Trade): string {
  return `${t.symbol}|${t.entry_price}|${t.entry_date}`;
}

function mergeTrades(trades: ClosedTradeWithPct[]): MergedTrade[] {
  const groups = new Map<string, ClosedTradeWithPct[]>();
  const order: string[] = [];

  for (const t of trades) {
    const key = groupKey(t);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(t);
  }

  return order.map((key) => {
    const group = groups.get(key)!;

    if (group.length === 1) {
      return {
        ...group[0],
        closes_count: 1,
        child_trades: group,
        child_ids: [group[0].id],
      };
    }

    const sorted = [...group].sort((a, b) =>
      (a.exit_date || "").localeCompare(b.exit_date || "")
    );

    const totalQty = group.reduce((s, t) => s + t.quantity, 0);
    const totalPnl = group.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const weightedExitPrice =
      totalQty > 0
        ? group.reduce((s, t) => s + (t.exit_price ?? 0) * t.quantity, 0) /
          totalQty
        : 0;
    const latestExitDate = group.reduce((latest, t) => {
      const d = t.exit_date || "";
      return d > latest ? d : latest;
    }, "");
    const cost = group[0].entry_price * totalQty;
    const pnlPct = cost > 0 ? (totalPnl / cost) * 100 : 0;

    const slDiff =
      group[0].side === "LONG"
        ? group[0].entry_price - group[0].initial_stop_loss
        : group[0].initial_stop_loss - group[0].entry_price;
    const rr = slDiff > 0 ? totalPnl / (slDiff * totalQty) : undefined;

    const resultType: "WIN" | "LOSS" | "BE" =
      totalPnl > 0.01 ? "WIN" : totalPnl < -0.01 ? "LOSS" : "BE";

    return {
      ...group[0],
      id: group[0].id,
      quantity: totalQty,
      exit_price: Math.round(weightedExitPrice * 100) / 100,
      exit_date: latestExitDate,
      pnl: Math.round(totalPnl * 100) / 100,
      rr: rr != null ? Math.round(rr * 100) / 100 : undefined,
      result_type: resultType,
      pnl_pct: Math.round(pnlPct * 100) / 100,
      closes_count: group.length,
      child_trades: sorted,
      child_ids: group.map((t) => t.id),
    };
  });
}

function assignVisualIds(trades: MergedTrade[]): MergedTrade[] {
  const sorted = [...trades].sort(
    (a, b) =>
      new Date(a.exit_date || "").getTime() -
      new Date(b.exit_date || "").getTime()
  );
  sorted.forEach((t, i) => (t.visual_id = i + 1));
  return sorted.reverse();
}

const KNOWN_COLS = new Set([
  "TICKER", "SYMBOL", "SIDE", "QTY", "QUANTITY",
  "PRECIO IN", "PRECIO ENTRADA", "ENTRY_PRICE", "PRICE", "PRECIO",
  "PRECIO OUT", "PRECIO SALIDA", "EXIT_PRICE", "EXIT PRICE",
  "FECHA IN", "ENTRY DATE", "ENTRY_DATE", "DATE", "FECHA",
  "FECHA OUT", "EXIT DATE", "EXIT_DATE",
  "SL", "STOP LOSS", "STOPLOSS", "INITIAL_STOP_LOSS", "S.L.", "CURRENT_STOP_LOSS",
  "RESULTADO", "RESULT", "RESULT_TYPE", "PNL", "RR", "PNL $", "P&L", "R", "RISK", "REWARD",
  "ENTRY NOTES", "EXIT NOTES", "NOTAS ENTRADA", "NOTAS SALIDA", "NOTES",
]);

function getCol(row: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== "" && row[k] !== "NaN") return row[k];
  }
  return "";
}

function safeFloat(v: string): number {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

export default function HistorialPage() {
  const { session } = useSession();
  const user = session?.user;
  const config = session?.config || {};
  const sym = curSym(config);
  const strategyKeys = getStrategyKeys(config);

  const { data: rawTrades = [], mutate: mutateTrades } = useSWR(
    user ? `trades-closed-${user}` : null,
    () => getClosedTrades(user!)
  );

  const mergedTrades = useMemo(
    () => assignVisualIds(mergeTrades(addPnlPct(rawTrades))),
    [rawTrades]
  );

  type SortKey =
    | "visual_id"
    | "entry_date"
    | "symbol"
    | "side"
    | "quantity"
    | "result_type"
    | "entry_price"
    | "exit_price"
    | "rr"
    | "pnl"
    | "pnl_pct"
    | "exit_date";

  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState("");
  const [importing, setImporting] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [sortKey, setSortKey] = useState<SortKey>("visual_id");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const fileRef = useRef<HTMLInputElement>(null);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
    setPage(0);
  }

  const trades = [...mergedTrades].sort((a, b) => {
    const key = sortKey;
    let aVal = a[key];
    let bVal = b[key];
    if (aVal == null) aVal = key === "entry_date" || key === "exit_date" ? "" : 0;
    if (bVal == null) bVal = key === "entry_date" || key === "exit_date" ? "" : 0;
    let cmp: number;
    if (typeof aVal === "number" && typeof bVal === "number") {
      cmp = aVal - bVal;
    } else {
      cmp = String(aVal).localeCompare(String(bVal));
    }
    return sortDir === "asc" ? cmp : -cmp;
  });

  const totalPages = Math.max(1, Math.ceil(trades.length / pageSize));
  const pagedTrades = trades.slice(page * pageSize, (page + 1) * pageSize);

  function toggleExpand(t: MergedTrade) {
    const key = groupKey(t);
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function handleRowClick(t: MergedTrade) {
    if (t.closes_count > 1) {
      toggleExpand(t);
    } else {
      const isSelected = selectedIds.length === 1 && selectedIds[0] === t.id;
      setSelectedIds(isSelected ? [] : [t.id]);
    }
  }

  function handleChildClick(childId: number) {
    const isSelected = selectedIds.length === 1 && selectedIds[0] === childId;
    setSelectedIds(isSelected ? [] : [childId]);
  }

  async function handleDeleteSelected() {
    if (selectedIds.length === 0) return;
    if (!confirm("¿Eliminar este trade del historial?")) return;
    let allOk = true;
    for (const id of selectedIds) {
      const ok = await deleteTrade(id);
      if (!ok) allOk = false;
    }
    if (allOk) {
      setMsg("Trade eliminado.");
      setSelectedIds([]);
      mutateTrades();
    } else {
      setMsg("Error al eliminar");
    }
  }

  async function handleDeleteAll() {
    if (!user) return;
    if (!confirm("¿Eliminar TODO el historial? Esta acción NO se puede deshacer."))
      return;
    const ok = await deleteAllClosedTrades(user);
    if (ok) {
      setMsg("Historial eliminado.");
      mutateTrades();
    } else {
      setMsg("Error al eliminar historial");
    }
  }

  const handleImport = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !user) return;
      setImporting(true);
      setMsg("Importando...");

      try {
        const Papa = (await import("papaparse")).default;
        const text = await file.text();
        const result = Papa.parse(text, { header: true, skipEmptyLines: true });
        const rows = result.data as Record<string, string>[];

        let count = 0;
        for (const rawRow of rows) {
          const row: Record<string, string> = {};
          for (const [k, v] of Object.entries(rawRow)) {
            row[k.trim().toUpperCase()] = String(v ?? "").trim();
          }

          const symbol = getCol(row, "TICKER", "SYMBOL").toUpperCase();
          if (!symbol) continue;

          const side = (getCol(row, "SIDE") || "LONG").toUpperCase();
          const qty = Math.max(1, Math.round(safeFloat(getCol(row, "QTY", "QUANTITY"))));
          const precioIn = safeFloat(
            getCol(row, "PRECIO IN", "PRECIO ENTRADA", "ENTRY_PRICE", "PRICE", "PRECIO")
          );
          const precioOutRaw = getCol(row, "PRECIO OUT", "PRECIO SALIDA", "EXIT_PRICE", "EXIT PRICE");
          const precioOut = precioOutRaw ? safeFloat(precioOutRaw) : precioIn;
          const sl = safeFloat(
            getCol(row, "SL", "STOP LOSS", "STOPLOSS", "INITIAL_STOP_LOSS", "S.L.")
          );

          let fechaIn: string;
          try {
            const raw = getCol(row, "FECHA IN", "ENTRY DATE", "ENTRY_DATE", "DATE", "FECHA");
            fechaIn = raw ? new Date(raw).toISOString().split("T")[0] : new Date().toISOString().split("T")[0];
          } catch {
            fechaIn = new Date().toISOString().split("T")[0];
          }

          let fechaOut: string;
          try {
            const raw = getCol(row, "FECHA OUT", "EXIT DATE", "EXIT_DATE");
            fechaOut = raw ? new Date(raw).toISOString().split("T")[0] : fechaIn;
          } catch {
            fechaOut = fechaIn;
          }

          let resultado = (getCol(row, "RESULTADO", "RESULT", "RESULT_TYPE") || "WIN").toUpperCase();
          if (!["WIN", "LOSS", "BE"].includes(resultado)) resultado = "WIN";

          const tags: Record<string, string> = {};
          for (const [k, v] of Object.entries(row)) {
            if (!KNOWN_COLS.has(k) && v) {
              tags[k.charAt(0).toUpperCase() + k.slice(1).toLowerCase()] = v;
            }
          }

          await openNewTrade(user, symbol, side, precioIn, qty, fechaIn, sl, sl, tags);
          const openList = await getOpenTrades(user);
          if (openList.length > 0) {
            const lastId = Math.max(...openList.map((t) => t.id));
            await closeTradeTotal(lastId, precioOut, fechaOut, resultado);
            count++;
          }
        }

        setMsg(`${count} trades importados.`);
        mutateTrades();
      } catch (err) {
        console.error("Import error:", err);
        setMsg("Error al leer el archivo.");
      } finally {
        setImporting(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [user, mutateTrades]
  );

  const totalRawTrades = rawTrades.length;

  const INPUT =
    "bg-bg border border-border rounded px-3 py-2 text-text-main focus:border-accent outline-none transition text-sm";

  function resultColor(rt?: string) {
    if (rt === "WIN") return "text-accent";
    if (rt === "LOSS") return "text-negative";
    return "text-neutral";
  }

  return (
    <div className="space-y-4">
      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={handleDeleteSelected}
          disabled={selectedIds.length === 0}
          className="px-4 py-2 border border-border rounded text-sm font-bold text-text-main hover:border-accent transition disabled:opacity-30 disabled:cursor-not-allowed"
        >
          BORRAR SELECCION
        </button>
        <button
          onClick={handleDeleteAll}
          className="px-4 py-2 border border-negative rounded text-sm font-bold text-negative bg-negative/5 hover:bg-negative/10 transition"
        >
          BORRAR BD COMPLETA
        </button>
        <label className="px-4 py-2 border border-border rounded text-sm font-bold text-neutral hover:text-text-main hover:border-accent cursor-pointer transition">
          {importing ? "IMPORTANDO..." : "IMPORTAR CSV"}
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={handleImport}
            className="hidden"
            disabled={importing}
          />
        </label>
        {mergedTrades.length !== totalRawTrades && (
          <span className="text-xs text-neutral">
            {mergedTrades.length} operaciones ({totalRawTrades} registros)
          </span>
        )}
        {msg && (
          <span className="text-sm font-semibold text-accent">{msg}</span>
        )}
      </div>

      {/* Table */}
      <div className="bg-card border border-border rounded-lg overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-bg uppercase text-xs tracking-wider">
                {(
                  [
                    { key: "visual_id" as SortKey, label: "#", align: "text-center w-8" },
                    { key: "entry_date" as SortKey, label: "Fecha In", align: "text-left" },
                    { key: "symbol" as SortKey, label: "Symbol", align: "text-left" },
                    { key: "side" as SortKey, label: "Side", align: "text-left" },
                    { key: "quantity" as SortKey, label: "Qty", align: "text-right" },
                    { key: "result_type" as SortKey, label: "Resultado", align: "text-center" },
                    { key: "entry_price" as SortKey, label: `In (${sym})`, align: "text-right" },
                    { key: "exit_price" as SortKey, label: `Out (${sym})`, align: "text-right" },
                  ] as { key: SortKey; label: string; align: string }[]
                ).map((col) => (
                  <th
                    key={col.key}
                    onClick={() => handleSort(col.key)}
                    className={`px-3 py-2.5 ${col.align} cursor-pointer select-none ${sortKey === col.key ? "text-text-main" : "text-neutral"}`}
                  >
                    {col.label}{" "}
                    <span className="text-[10px]">
                      {sortKey === col.key ? (sortDir === "asc" ? "▲" : "▼") : ""}
                    </span>
                  </th>
                ))}
                <th className="px-3 py-2.5 text-right text-neutral">SL ({sym})</th>
                {strategyKeys.map((k) => (
                  <th key={k} className="px-3 py-2.5 text-left text-neutral">
                    {k}
                  </th>
                ))}
                {(
                  [
                    { key: "rr" as SortKey, label: "R", align: "text-right" },
                    { key: "pnl" as SortKey, label: `PnL (${sym})`, align: "text-right" },
                    { key: "pnl_pct" as SortKey, label: "PnL %", align: "text-right" },
                    { key: "exit_date" as SortKey, label: "Fecha Out", align: "text-left" },
                  ] as { key: SortKey; label: string; align: string }[]
                ).map((col) => (
                  <th
                    key={col.key}
                    onClick={() => handleSort(col.key)}
                    className={`px-3 py-2.5 ${col.align} cursor-pointer select-none ${sortKey === col.key ? "text-text-main" : "text-neutral"}`}
                  >
                    {col.label}{" "}
                    <span className="text-[10px]">
                      {sortKey === col.key ? (sortDir === "asc" ? "▲" : "▼") : ""}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pagedTrades.length === 0 ? (
                <tr>
                  <td
                    colSpan={13 + strategyKeys.length}
                    className="px-3 py-8 text-center text-neutral"
                  >
                    Sin trades cerrados
                  </td>
                </tr>
              ) : (
                pagedTrades.flatMap((t, i) => {
                  const isExpanded =
                    t.closes_count > 1 && expandedKeys.has(groupKey(t));
                  const isGroupSelected =
                    selectedIds.length > 0 &&
                    t.child_ids.some((id) => selectedIds.includes(id));
                  const pnl = t.pnl ?? 0;
                  const pnlPct = t.pnl_pct;

                  const mainRow = (
                    <tr
                      key={`main-${t.id}`}
                      onClick={() => handleRowClick(t)}
                      className={`cursor-pointer transition-colors ${
                        isGroupSelected
                          ? "bg-accent/10"
                          : i % 2 === 1
                            ? "bg-row-odd hover:bg-neutral/5"
                            : "hover:bg-neutral/5"
                      }`}
                    >
                      <td className="px-3 py-2 text-center text-neutral">
                        {t.visual_id}
                      </td>
                      <td className="px-3 py-2">{t.entry_date}</td>
                      <td className="px-3 py-2 font-semibold">
                        {t.symbol}
                        {t.closes_count > 1 && (
                          <span className="ml-1.5 text-[10px] font-bold text-neutral bg-neutral/15 px-1.5 py-0.5 rounded">
                            {isExpanded ? "▾" : "▸"} {t.closes_count} cierres
                          </span>
                        )}
                      </td>
                      <td
                        className={`px-3 py-2 font-semibold ${
                          t.side === "LONG" ? "text-accent" : "text-negative"
                        }`}
                      >
                        {t.side}
                      </td>
                      <td className="px-3 py-2 text-right">{t.quantity}</td>
                      <td className={`px-3 py-2 text-center font-bold ${resultColor(t.result_type)}`}>
                        {t.result_type}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {sym}
                        {t.entry_price.toFixed(2)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {t.exit_price != null
                          ? `${sym}${t.exit_price.toFixed(2)}`
                          : ""}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {t.initial_stop_loss
                          ? `${sym}${t.initial_stop_loss.toFixed(2)}`
                          : ""}
                      </td>
                      {strategyKeys.map((k) => (
                        <td key={k} className="px-3 py-2 text-neutral">
                          {t.tags?.[k] || ""}
                        </td>
                      ))}
                      <td className="px-3 py-2 text-right">
                        {t.rr != null ? `${t.rr.toFixed(2)}R` : ""}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-semibold ${
                          pnl >= 0 ? "text-accent" : "text-negative"
                        }`}
                      >
                        {fmtMoney2(pnl, sym)}
                      </td>
                      <td
                        className={`px-3 py-2 text-right ${
                          pnlPct >= 0 ? "text-accent" : "text-negative"
                        }`}
                      >
                        {pnlPct.toFixed(2)}%
                      </td>
                      <td className="px-3 py-2">{t.exit_date || ""}</td>
                    </tr>
                  );

                  if (!isExpanded) return [mainRow];

                  const childRows = t.child_trades.map((child) => {
                    const childPnl = child.pnl ?? 0;
                    const childCost = child.entry_price * child.quantity;
                    const childPnlPct =
                      childCost > 0 ? (childPnl / childCost) * 100 : 0;
                    const isChildSelected = selectedIds.includes(child.id);

                    return (
                      <tr
                        key={`child-${child.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleChildClick(child.id);
                        }}
                        className={`cursor-pointer transition-colors border-l-2 border-accent/30 ${
                          isChildSelected
                            ? "bg-accent/15"
                            : "bg-bg/50 hover:bg-neutral/5"
                        }`}
                      >
                        <td className="px-3 py-1.5 text-center text-neutral text-[10px]">
                          └
                        </td>
                        <td className="px-3 py-1.5 text-neutral text-xs">
                          {child.entry_date}
                        </td>
                        <td className="px-3 py-1.5 text-neutral text-xs">
                          {child.symbol}
                        </td>
                        <td
                          className={`px-3 py-1.5 text-xs ${
                            child.side === "LONG"
                              ? "text-accent/70"
                              : "text-negative/70"
                          }`}
                        >
                          {child.side}
                        </td>
                        <td className="px-3 py-1.5 text-right text-xs text-neutral">
                          {child.quantity}
                        </td>
                        <td
                          className={`px-3 py-1.5 text-center text-xs font-bold ${resultColor(child.result_type)}`}
                        >
                          {child.result_type}
                        </td>
                        <td className="px-3 py-1.5 text-right text-xs text-neutral">
                          {sym}
                          {child.entry_price.toFixed(2)}
                        </td>
                        <td className="px-3 py-1.5 text-right text-xs text-neutral">
                          {child.exit_price != null
                            ? `${sym}${child.exit_price.toFixed(2)}`
                            : ""}
                        </td>
                        <td className="px-3 py-1.5 text-right text-xs text-neutral">
                          {child.initial_stop_loss
                            ? `${sym}${child.initial_stop_loss.toFixed(2)}`
                            : ""}
                        </td>
                        {strategyKeys.map((k) => (
                          <td key={k} className="px-3 py-1.5 text-neutral text-xs">
                            {child.tags?.[k] || ""}
                          </td>
                        ))}
                        <td className="px-3 py-1.5 text-right text-xs text-neutral">
                          {child.rr != null ? `${child.rr.toFixed(2)}R` : ""}
                        </td>
                        <td
                          className={`px-3 py-1.5 text-right text-xs font-semibold ${
                            childPnl >= 0 ? "text-accent" : "text-negative"
                          }`}
                        >
                          {fmtMoney2(childPnl, sym)}
                        </td>
                        <td
                          className={`px-3 py-1.5 text-right text-xs ${
                            childPnlPct >= 0 ? "text-accent" : "text-negative"
                          }`}
                        >
                          {childPnlPct.toFixed(2)}%
                        </td>
                        <td className="px-3 py-1.5 text-xs text-neutral">
                          {child.exit_date || ""}
                        </td>
                      </tr>
                    );
                  });

                  return [mainRow, ...childRows];
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {trades.length > 0 && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral">Mostrar</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(0);
              }}
              className={INPUT}
            >
              {[10, 25, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span className="text-xs text-neutral">
              de {trades.length} operaciones
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-2 py-1 text-xs text-neutral hover:text-text-main disabled:opacity-30"
            >
              &#9664;
            </button>
            <span className="text-xs text-text-main px-2">
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="px-2 py-1 text-xs text-neutral hover:text-text-main disabled:opacity-30"
            >
              &#9654;
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
