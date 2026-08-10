"use client";

import { useState, useRef, useCallback } from "react";
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

function addPnlPct(trades: Trade[]): ClosedTradeWithPct[] {
  return trades.map((t, _i, arr) => {
    const cost = t.entry_price * t.quantity;
    const pnlPct = cost > 0 && t.pnl != null ? (t.pnl / cost) * 100 : 0;
    return { ...t, pnl_pct: Math.round(pnlPct * 100) / 100 };
  });
}

function assignVisualIds(trades: ClosedTradeWithPct[]): ClosedTradeWithPct[] {
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

  const tradesWithIds = assignVisualIds(addPnlPct(rawTrades));

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

  const [selectedId, setSelectedId] = useState<number | null>(null);
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

  const trades = [...tradesWithIds].sort((a, b) => {
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

  async function handleDeleteSelected() {
    if (selectedId == null) return;
    if (!confirm("¿Eliminar este trade del historial?")) return;
    const ok = await deleteTrade(selectedId);
    if (ok) {
      setMsg("Trade eliminado.");
      setSelectedId(null);
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

  const INPUT =
    "bg-bg border border-border rounded px-3 py-2 text-text-main focus:border-accent outline-none transition text-sm";

  return (
    <div className="space-y-4">
      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={handleDeleteSelected}
          disabled={selectedId == null}
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
                pagedTrades.map((t, i) => {
                  const isSelected = selectedId === t.id;
                  const pnl = t.pnl ?? 0;
                  const pnlPct = t.pnl_pct;
                  const resultColor =
                    t.result_type === "WIN"
                      ? "text-accent"
                      : t.result_type === "LOSS"
                        ? "text-negative"
                        : "text-neutral";

                  return (
                    <tr
                      key={t.id}
                      onClick={() =>
                        setSelectedId(isSelected ? null : t.id)
                      }
                      className={`cursor-pointer transition-colors ${
                        isSelected
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
                      <td className="px-3 py-2 font-semibold">{t.symbol}</td>
                      <td
                        className={`px-3 py-2 font-semibold ${
                          t.side === "LONG" ? "text-accent" : "text-negative"
                        }`}
                      >
                        {t.side}
                      </td>
                      <td className="px-3 py-2 text-right">{t.quantity}</td>
                      <td className={`px-3 py-2 text-center font-bold ${resultColor}`}>
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
              de {trades.length} trades
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
