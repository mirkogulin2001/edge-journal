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
  updateTradeExPostBe,
  updateTrade,
} from "@/lib/db/trades";
import { curSym, fmtMoney2, getStrategyKeys } from "@/lib/calculations/helpers";
import type { Trade, ClosedTradeWithPct } from "@/types/trade";
import useSWR from "swr";

interface MergedTrade extends ClosedTradeWithPct {
  closes_count: number;
  child_trades: ClosedTradeWithPct[];
  child_ids: number[];
  ex_post_be: boolean;
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

function hasExPostBe(t: Trade): boolean {
  return t.tags?._ex_post_be === "true";
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
        ex_post_be: hasExPostBe(group[0]),
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
      ex_post_be: group.some(hasExPostBe),
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

  const allMerged = useMemo(
    () => assignVisualIds(mergeTrades(addPnlPct(rawTrades))),
    [rawTrades]
  );

  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [filterSymbol, setFilterSymbol] = useState("");
  const [filterSide, setFilterSide] = useState("");
  const [filterStrategy, setFilterStrategy] = useState<Record<string, string>>({});
  const [filtersOpen, setFiltersOpen] = useState(false);

  const symbols = useMemo(
    () => Array.from(new Set(allMerged.map((t) => t.symbol))).sort(),
    [allMerged]
  );

  const filteredTrades = useMemo(() => {
    let trades = allMerged;
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
  }, [allMerged, filterFrom, filterTo, filterSymbol, filterSide, filterStrategy]);

  const hasActiveFilters =
    !!filterFrom || !!filterTo || !!filterSymbol || !!filterSide ||
    Object.values(filterStrategy).some(Boolean);

  function clearFilters() {
    setFilterFrom("");
    setFilterTo("");
    setFilterSymbol("");
    setFilterSide("");
    setFilterStrategy({});
  }

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

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValues, setEditValues] = useState({
    symbol: "",
    side: "LONG",
    entry_price: 0,
    exit_price: 0,
    quantity: 0,
    entry_date: "",
    exit_date: "",
    initial_stop_loss: 0,
    result_type: "WIN",
  });
  const [saving, setSaving] = useState(false);

  function startEdit(t: ClosedTradeWithPct) {
    setEditingId(t.id);
    setSelectedIds([]);
    setEditValues({
      symbol: t.symbol,
      side: t.side,
      entry_price: t.entry_price,
      exit_price: t.exit_price ?? 0,
      quantity: t.quantity,
      entry_date: t.entry_date,
      exit_date: t.exit_date || "",
      initial_stop_loss: t.initial_stop_loss,
      result_type: t.result_type || "WIN",
    });
  }

  async function saveEdit() {
    if (editingId == null) return;
    setSaving(true);
    const ok = await updateTrade(editingId, editValues);
    setSaving(false);
    if (ok) {
      setEditingId(null);
      mutateTrades();
      setMsg("Trade actualizado");
    } else {
      setMsg("Error al actualizar");
    }
  }

  function cancelEdit() {
    setEditingId(null);
  }

  const previewCalc = useMemo(() => {
    const { side, entry_price, exit_price, quantity, initial_stop_loss } = editValues;
    const pnl =
      side === "LONG"
        ? (exit_price - entry_price) * quantity
        : (entry_price - exit_price) * quantity;
    const cost = entry_price * quantity;
    const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0;
    let rr = 0;
    if (initial_stop_loss !== 0 && initial_stop_loss !== entry_price) {
      const risk = Math.abs(entry_price - initial_stop_loss) * quantity;
      rr = risk > 0 ? pnl / risk : 0;
    }
    return {
      pnl: Math.round(pnl * 100) / 100,
      rr: Math.round(rr * 100) / 100,
      pnlPct: Math.round(pnlPct * 100) / 100,
    };
  }, [editValues]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
    setPage(0);
  }

  const trades = [...filteredTrades].sort((a, b) => {
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
    if (editingId != null) return;
    if (t.closes_count > 1) {
      toggleExpand(t);
    } else {
      const alreadySelected = selectedIds.length === 1 && selectedIds[0] === t.id;
      setSelectedIds(alreadySelected ? [] : [t.id]);
    }
  }

  function handleChildClick(child: ClosedTradeWithPct) {
    if (editingId != null) return;
    const alreadySelected = selectedIds.length === 1 && selectedIds[0] === child.id;
    setSelectedIds(alreadySelected ? [] : [child.id]);
  }

  function handleEditSelected() {
    if (selectedIds.length !== 1) return;
    const id = selectedIds[0];
    const found = rawTrades.find((t) => t.id === id);
    if (found) startEdit(found as ClosedTradeWithPct);
  }

  async function handleToggleExPostBe(t: MergedTrade, e: React.MouseEvent) {
    e.stopPropagation();
    const newVal = !t.ex_post_be;
    for (const id of t.child_ids) {
      await updateTradeExPostBe(id, newVal);
    }
    mutateTrades();
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

  const INPUT_CLS =
    "bg-bg border border-border rounded px-3 py-1.5 text-text-main text-sm focus:border-accent outline-none";
  const EDIT_CLS =
    "bg-bg border border-accent/40 rounded px-1.5 py-1 text-text-main text-xs focus:border-accent outline-none";

  function resultColor(rt?: string) {
    if (rt === "WIN") return "text-accent";
    if (rt === "LOSS") return "text-negative";
    return "text-neutral";
  }

  const colCount = 14 + strategyKeys.length;

  return (
    <div className="space-y-4">
      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={handleEditSelected}
          disabled={selectedIds.length !== 1 || editingId != null}
          className="px-4 py-2 border border-accent rounded text-sm font-bold text-accent hover:bg-accent/10 transition disabled:opacity-30 disabled:cursor-not-allowed"
        >
          EDITAR
        </button>
        <button
          onClick={async () => {
            const idToDel = editingId ?? (selectedIds.length === 1 ? selectedIds[0] : null);
            if (idToDel == null) return;
            if (!confirm("¿Eliminar este trade del historial?")) return;
            const ok = await deleteTrade(idToDel);
            if (ok) {
              setMsg("Trade eliminado.");
              setEditingId(null);
              setSelectedIds([]);
              mutateTrades();
            } else {
              setMsg("Error al eliminar");
            }
          }}
          disabled={editingId == null && selectedIds.length !== 1}
          className="px-4 py-2 border border-border rounded text-sm font-bold text-text-main hover:border-accent transition disabled:opacity-30 disabled:cursor-not-allowed"
        >
          BORRAR
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
        <button
          onClick={() => setFiltersOpen((o) => !o)}
          className={`px-3 py-2 text-xs font-bold rounded border transition ${
            hasActiveFilters
              ? "border-accent text-accent bg-accent/10"
              : "border-border text-neutral hover:text-text-main"
          }`}
        >
          {filtersOpen ? "OCULTAR FILTROS" : "FILTROS"}
          {hasActiveFilters && ` (${filteredTrades.length}/${allMerged.length})`}
        </button>
        {hasActiveFilters && (
          <button
            onClick={clearFilters}
            className="text-xs text-negative font-bold hover:text-negative/80 transition"
          >
            LIMPIAR
          </button>
        )}
        {allMerged.length !== totalRawTrades && !hasActiveFilters && (
          <span className="text-xs text-neutral">
            {allMerged.length} operaciones ({totalRawTrades} registros)
          </span>
        )}
        {msg && (
          <span className="text-sm font-semibold text-accent">{msg}</span>
        )}
      </div>

      {/* Filters */}
      {filtersOpen && (
        <div className="flex flex-wrap gap-3 p-4 bg-card rounded border border-border">
          <div>
            <label className="block text-[10px] text-neutral font-bold mb-1">DESDE</label>
            <input
              type="date"
              value={filterFrom}
              onChange={(e) => { setFilterFrom(e.target.value); setPage(0); }}
              className={`w-36 ${INPUT_CLS}`}
            />
          </div>
          <div>
            <label className="block text-[10px] text-neutral font-bold mb-1">HASTA</label>
            <input
              type="date"
              value={filterTo}
              onChange={(e) => { setFilterTo(e.target.value); setPage(0); }}
              className={`w-36 ${INPUT_CLS}`}
            />
          </div>
          <div>
            <label className="block text-[10px] text-neutral font-bold mb-1">ACTIVO</label>
            <select
              value={filterSymbol}
              onChange={(e) => { setFilterSymbol(e.target.value); setPage(0); }}
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
              onChange={(e) => { setFilterSide(e.target.value); setPage(0); }}
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
                  onChange={(e) => {
                    setFilterStrategy((prev) => ({ ...prev, [k]: e.target.value }));
                    setPage(0);
                  }}
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
                <th className="px-2 py-2.5 text-center text-neutral whitespace-nowrap">
                  Ex-post BE
                </th>
              </tr>
            </thead>
            <tbody>
              {pagedTrades.length === 0 ? (
                <tr>
                  <td
                    colSpan={colCount}
                    className="px-3 py-8 text-center text-neutral"
                  >
                    Sin trades cerrados
                  </td>
                </tr>
              ) : (
                pagedTrades.flatMap((t, i) => {
                  const isExpanded =
                    t.closes_count > 1 && expandedKeys.has(groupKey(t));
                  const pnl = t.pnl ?? 0;
                  const pnlPct = t.pnl_pct;
                  const isBe = t.result_type === "BE";
                  const isEditing = t.closes_count === 1 && editingId === t.id;

                  const mainRow = isEditing ? (
                    <tr
                      key={`edit-${t.id}`}
                      className="bg-accent/5"
                    >
                      <td className="px-3 py-2 text-center">
                        <button
                          onClick={cancelEdit}
                          className="text-neutral hover:text-negative text-sm"
                          title="Cancelar"
                        >
                          ✕
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="date"
                          value={editValues.entry_date}
                          onChange={(e) => setEditValues((v) => ({ ...v, entry_date: e.target.value }))}
                          className={`${EDIT_CLS} w-[120px]`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={editValues.symbol}
                          onChange={(e) => setEditValues((v) => ({ ...v, symbol: e.target.value.toUpperCase() }))}
                          className={`${EDIT_CLS} w-20`}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={editValues.side}
                          onChange={(e) => setEditValues((v) => ({ ...v, side: e.target.value }))}
                          className={EDIT_CLS}
                        >
                          <option value="LONG">LONG</option>
                          <option value="SHORT">SHORT</option>
                        </select>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input
                          type="number"
                          value={editValues.quantity}
                          onChange={(e) => setEditValues((v) => ({ ...v, quantity: Math.max(0, parseInt(e.target.value) || 0) }))}
                          className={`${EDIT_CLS} w-16 text-right`}
                        />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <select
                          value={editValues.result_type}
                          onChange={(e) => setEditValues((v) => ({ ...v, result_type: e.target.value }))}
                          className={EDIT_CLS}
                        >
                          <option value="WIN">WIN</option>
                          <option value="LOSS">LOSS</option>
                          <option value="BE">BE</option>
                        </select>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input
                          type="number"
                          step="0.01"
                          value={editValues.entry_price}
                          onChange={(e) => setEditValues((v) => ({ ...v, entry_price: parseFloat(e.target.value) || 0 }))}
                          className={`${EDIT_CLS} w-24 text-right`}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input
                          type="number"
                          step="0.01"
                          value={editValues.exit_price}
                          onChange={(e) => setEditValues((v) => ({ ...v, exit_price: parseFloat(e.target.value) || 0 }))}
                          className={`${EDIT_CLS} w-24 text-right`}
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input
                          type="number"
                          step="0.01"
                          value={editValues.initial_stop_loss}
                          onChange={(e) => setEditValues((v) => ({ ...v, initial_stop_loss: parseFloat(e.target.value) || 0 }))}
                          className={`${EDIT_CLS} w-24 text-right`}
                        />
                      </td>
                      {strategyKeys.map((k) => (
                        <td key={k} className="px-3 py-2 text-neutral text-xs">
                          {t.tags?.[k] || ""}
                        </td>
                      ))}
                      <td className={`px-3 py-2 text-right text-xs ${previewCalc.rr >= 0 ? "text-accent" : "text-negative"}`}>
                        {previewCalc.rr.toFixed(2)}R
                      </td>
                      <td className={`px-3 py-2 text-right text-xs font-semibold ${previewCalc.pnl >= 0 ? "text-accent" : "text-negative"}`}>
                        {fmtMoney2(previewCalc.pnl, sym)}
                      </td>
                      <td className={`px-3 py-2 text-right text-xs ${previewCalc.pnlPct >= 0 ? "text-accent" : "text-negative"}`}>
                        {previewCalc.pnlPct.toFixed(2)}%
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="date"
                          value={editValues.exit_date}
                          onChange={(e) => setEditValues((v) => ({ ...v, exit_date: e.target.value }))}
                          className={`${EDIT_CLS} w-[120px]`}
                        />
                      </td>
                      <td className="px-2 py-2 text-center">
                        <button
                          onClick={saveEdit}
                          disabled={saving}
                          className="px-2.5 py-1 bg-accent text-bg text-[10px] font-bold rounded hover:bg-accent/80 transition disabled:opacity-50"
                        >
                          {saving ? "..." : "OK"}
                        </button>
                      </td>
                    </tr>
                  ) : (
                    <tr
                      key={`main-${t.id}`}
                      onClick={() => handleRowClick(t)}
                      className={`cursor-pointer transition-colors ${
                        selectedIds.includes(t.id)
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
                      <td className="px-2 py-2 text-center">
                        {isBe && (
                          <input
                            type="checkbox"
                            checked={t.ex_post_be}
                            onClick={(e) => handleToggleExPostBe(t, e)}
                            onChange={() => {}}
                            className="w-4 h-4 accent-accent cursor-pointer"
                            title="El precio fue al nivel de stop post-cierre"
                          />
                        )}
                      </td>
                    </tr>
                  );

                  if (!isExpanded) return [mainRow];

                  const childRows = t.child_trades.map((child) => {
                    const childPnl = child.pnl ?? 0;
                    const childCost = child.entry_price * child.quantity;
                    const childPnlPct =
                      childCost > 0 ? (childPnl / childCost) * 100 : 0;
                    const isChildEditing = editingId === child.id;

                    if (isChildEditing) {
                      return (
                        <tr
                          key={`child-edit-${child.id}`}
                          className="bg-accent/5 border-l-2 border-accent"
                        >
                          <td className="px-3 py-1.5 text-center">
                            <button
                              onClick={cancelEdit}
                              className="text-neutral hover:text-negative text-xs"
                            >
                              ✕
                            </button>
                          </td>
                          <td className="px-3 py-1.5">
                            <input
                              type="date"
                              value={editValues.entry_date}
                              onChange={(e) => setEditValues((v) => ({ ...v, entry_date: e.target.value }))}
                              className={`${EDIT_CLS} w-[120px]`}
                            />
                          </td>
                          <td className="px-3 py-1.5">
                            <input
                              type="text"
                              value={editValues.symbol}
                              onChange={(e) => setEditValues((v) => ({ ...v, symbol: e.target.value.toUpperCase() }))}
                              className={`${EDIT_CLS} w-20`}
                            />
                          </td>
                          <td className="px-3 py-1.5">
                            <select
                              value={editValues.side}
                              onChange={(e) => setEditValues((v) => ({ ...v, side: e.target.value }))}
                              className={EDIT_CLS}
                            >
                              <option value="LONG">LONG</option>
                              <option value="SHORT">SHORT</option>
                            </select>
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            <input
                              type="number"
                              value={editValues.quantity}
                              onChange={(e) => setEditValues((v) => ({ ...v, quantity: Math.max(0, parseInt(e.target.value) || 0) }))}
                              className={`${EDIT_CLS} w-16 text-right`}
                            />
                          </td>
                          <td className="px-3 py-1.5 text-center">
                            <select
                              value={editValues.result_type}
                              onChange={(e) => setEditValues((v) => ({ ...v, result_type: e.target.value }))}
                              className={EDIT_CLS}
                            >
                              <option value="WIN">WIN</option>
                              <option value="LOSS">LOSS</option>
                              <option value="BE">BE</option>
                            </select>
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            <input
                              type="number"
                              step="0.01"
                              value={editValues.entry_price}
                              onChange={(e) => setEditValues((v) => ({ ...v, entry_price: parseFloat(e.target.value) || 0 }))}
                              className={`${EDIT_CLS} w-24 text-right`}
                            />
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            <input
                              type="number"
                              step="0.01"
                              value={editValues.exit_price}
                              onChange={(e) => setEditValues((v) => ({ ...v, exit_price: parseFloat(e.target.value) || 0 }))}
                              className={`${EDIT_CLS} w-24 text-right`}
                            />
                          </td>
                          <td className="px-3 py-1.5 text-right">
                            <input
                              type="number"
                              step="0.01"
                              value={editValues.initial_stop_loss}
                              onChange={(e) => setEditValues((v) => ({ ...v, initial_stop_loss: parseFloat(e.target.value) || 0 }))}
                              className={`${EDIT_CLS} w-24 text-right`}
                            />
                          </td>
                          {strategyKeys.map((k) => (
                            <td key={k} className="px-3 py-1.5 text-neutral text-xs">
                              {child.tags?.[k] || ""}
                            </td>
                          ))}
                          <td className={`px-3 py-1.5 text-right text-xs ${previewCalc.rr >= 0 ? "text-accent" : "text-negative"}`}>
                            {previewCalc.rr.toFixed(2)}R
                          </td>
                          <td className={`px-3 py-1.5 text-right text-xs font-semibold ${previewCalc.pnl >= 0 ? "text-accent" : "text-negative"}`}>
                            {fmtMoney2(previewCalc.pnl, sym)}
                          </td>
                          <td className={`px-3 py-1.5 text-right text-xs ${previewCalc.pnlPct >= 0 ? "text-accent" : "text-negative"}`}>
                            {previewCalc.pnlPct.toFixed(2)}%
                          </td>
                          <td className="px-3 py-1.5">
                            <input
                              type="date"
                              value={editValues.exit_date}
                              onChange={(e) => setEditValues((v) => ({ ...v, exit_date: e.target.value }))}
                              className={`${EDIT_CLS} w-[120px]`}
                            />
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <button
                              onClick={saveEdit}
                              disabled={saving}
                              className="px-2 py-1 bg-accent text-bg text-[10px] font-bold rounded hover:bg-accent/80 transition disabled:opacity-50"
                            >
                              {saving ? "..." : "OK"}
                            </button>
                          </td>
                        </tr>
                      );
                    }

                    return (
                      <tr
                        key={`child-${child.id}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleChildClick(child);
                        }}
                        className={`cursor-pointer transition-colors border-l-2 border-accent/30 ${
                          selectedIds.includes(child.id)
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
                        <td className="px-2 py-1.5"></td>
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
              className={INPUT_CLS}
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
