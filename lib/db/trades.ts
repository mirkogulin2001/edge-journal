import { getSupabase } from "@/lib/supabase/client";
import type { Trade } from "@/types/trade";

export async function getOpenTrades(username: string): Promise<Trade[]> {
  const { data, error } = await getSupabase()
    .from("trades")
    .select("*")
    .eq("username", username)
    .eq("status", "OPEN");
  if (error) { console.error("getOpenTrades:", error); return []; }
  return data as Trade[];
}

export async function getClosedTrades(username: string): Promise<Trade[]> {
  const { data, error } = await getSupabase()
    .from("trades")
    .select("*")
    .eq("username", username)
    .eq("status", "CLOSED");
  if (error) { console.error("getClosedTrades:", error); return []; }
  return data as Trade[];
}

export async function openNewTrade(
  username: string,
  symbol: string,
  side: string,
  price: number,
  quantity: number,
  dateVal: string,
  sl: number,
  currentSl: number,
  tags: Record<string, string>,
  entryNotes: string = ""
): Promise<boolean> {
  const { error } = await getSupabase().from("trades").insert({
    username,
    symbol,
    side,
    entry_price: price,
    quantity,
    entry_date: dateVal,
    initial_stop_loss: sl,
    current_stop_loss: currentSl,
    tags,
    entry_notes: entryNotes,
    status: "OPEN",
  });
  return !error;
}

export async function closeTradeTotal(
  tradeId: number,
  exitPrice: number,
  exitDate: string,
  resultType: string,
  exitNotes: string = ""
): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("trades")
    .select("*")
    .eq("id", tradeId)
    .single();
  if (error || !data) return false;

  const trade = data as Trade;
  const entryPrice = trade.entry_price;
  const qty = trade.quantity;
  const side = trade.side;
  const sl = trade.initial_stop_loss;

  const pnl =
    side === "LONG"
      ? (exitPrice - entryPrice) * qty
      : (entryPrice - exitPrice) * qty;

  let rr = 0;
  if (sl !== 0 && sl !== entryPrice) {
    const risk = Math.abs(entryPrice - sl) * qty;
    rr = risk > 0 ? pnl / risk : 0;
  }

  const { error: updateErr } = await getSupabase()
    .from("trades")
    .update({
      exit_price: exitPrice,
      exit_date: exitDate,
      result_type: resultType,
      pnl: Math.round(pnl * 100) / 100,
      rr: Math.round(rr * 100) / 100,
      status: "CLOSED",
      exit_notes: exitNotes,
    })
    .eq("id", tradeId);
  return !updateErr;
}

export async function closePartial(
  tradeId: number,
  partialQty: number,
  exitPrice: number,
  exitDate: string
): Promise<{ ok: boolean; message: string }> {
  const { data, error } = await getSupabase()
    .from("trades")
    .select("*")
    .eq("id", tradeId)
    .single();
  if (error || !data) return { ok: false, message: "Trade no encontrado" };

  const trade = data as Trade;
  const currentQty = trade.quantity;

  if (partialQty >= currentQty) {
    const ok = await closeTradeTotal(tradeId, exitPrice, exitDate, "WIN");
    return { ok, message: ok ? "Cerrado total" : "Error" };
  }

  const entryPrice = trade.entry_price;
  const side = trade.side;
  const sl = trade.initial_stop_loss;

  const pnlChunk =
    side === "LONG"
      ? (exitPrice - entryPrice) * partialQty
      : (entryPrice - exitPrice) * partialQty;

  const rType = pnlChunk > 0 ? "WIN" : pnlChunk < 0 ? "LOSS" : "BE";

  let rrChunk = 0;
  if (sl !== 0 && sl !== entryPrice) {
    const riskChunk = Math.abs(entryPrice - sl) * partialQty;
    rrChunk = riskChunk > 0 ? pnlChunk / riskChunk : 0;
  }

  const newRow: Record<string, unknown> = { ...trade };
  delete newRow.id;
  delete newRow.created_at;
  Object.assign(newRow, {
    quantity: partialQty,
    exit_price: exitPrice,
    exit_date: exitDate,
    pnl: Math.round(pnlChunk * 100) / 100,
    rr: Math.round(rrChunk * 100) / 100,
    result_type: rType,
    status: "CLOSED",
  });

  const { error: insertErr } = await getSupabase().from("trades").insert(newRow);
  if (insertErr) return { ok: false, message: insertErr.message };

  await getSupabase()
    .from("trades")
    .update({ quantity: currentQty - partialQty })
    .eq("id", tradeId);

  return { ok: true, message: "Parcial ejecutado" };
}

export async function updateStopLoss(
  tradeId: number,
  newSl: number
): Promise<boolean> {
  const { error } = await getSupabase()
    .from("trades")
    .update({ current_stop_loss: newSl })
    .eq("id", tradeId);
  return !error;
}

export async function deleteTrade(tradeId: number): Promise<boolean> {
  const { error } = await getSupabase()
    .from("trades")
    .delete()
    .eq("id", tradeId);
  return !error;
}

export async function updateTradeExPostBe(
  tradeId: number,
  value: boolean
): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("trades")
    .select("tags")
    .eq("id", tradeId)
    .single();
  if (error || !data) return false;

  const tags = (data.tags as Record<string, string>) || {};
  if (value) {
    tags._ex_post_be = "true";
  } else {
    delete tags._ex_post_be;
  }

  const { error: updateErr } = await getSupabase()
    .from("trades")
    .update({ tags })
    .eq("id", tradeId);
  return !updateErr;
}

export async function updateTrade(
  tradeId: number,
  updates: {
    symbol?: string;
    side?: string;
    entry_price?: number;
    exit_price?: number;
    quantity?: number;
    entry_date?: string;
    exit_date?: string;
    initial_stop_loss?: number;
    result_type?: string;
  }
): Promise<boolean> {
  const { data, error } = await getSupabase()
    .from("trades")
    .select("*")
    .eq("id", tradeId)
    .single();
  if (error || !data) return false;

  const trade = data as Trade;
  const side = updates.side ?? trade.side;
  const entryPrice = updates.entry_price ?? trade.entry_price;
  const exitPrice = updates.exit_price ?? trade.exit_price;
  const qty = updates.quantity ?? trade.quantity;
  const sl = updates.initial_stop_loss ?? trade.initial_stop_loss;

  const dbUpdate: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined) dbUpdate[k] = v;
  }
  if (updates.initial_stop_loss !== undefined) {
    dbUpdate.current_stop_loss = updates.initial_stop_loss;
  }

  if (trade.status === "CLOSED" && exitPrice != null) {
    const pnl =
      side === "LONG"
        ? (exitPrice - entryPrice) * qty
        : (entryPrice - exitPrice) * qty;

    let rr = 0;
    if (sl !== 0 && sl !== entryPrice) {
      const risk = Math.abs(entryPrice - sl) * qty;
      rr = risk > 0 ? pnl / risk : 0;
    }

    dbUpdate.pnl = Math.round(pnl * 100) / 100;
    dbUpdate.rr = Math.round(rr * 100) / 100;
  }

  if (Object.keys(dbUpdate).length === 0) return true;

  const { error: updateErr } = await getSupabase()
    .from("trades")
    .update(dbUpdate)
    .eq("id", tradeId);
  return !updateErr;
}

export async function deleteAllClosedTrades(
  username: string
): Promise<boolean> {
  const { error } = await getSupabase()
    .from("trades")
    .delete()
    .eq("username", username)
    .eq("status", "CLOSED");
  return !error;
}
