import type { Trade } from "@/types/trade";

// Partial closes are stored as separate CLOSED rows sharing symbol, entry price and entry date.
export function partialGroupKey(t: Trade): string {
  return `${t.symbol}|${t.entry_price}|${t.entry_date}`;
}

// Collapses partial closes into one trade so each position contributes a single R.
export function mergePartialCloses(trades: Trade[]): Trade[] {
  const groups = new Map<string, Trade[]>();
  for (const t of trades) {
    const key = partialGroupKey(t);
    const g = groups.get(key);
    if (g) g.push(t);
    else groups.set(key, [t]);
  }

  return Array.from(groups.values()).map((group): Trade => {
    if (group.length === 1) return group[0];

    const first = group[0];
    const totalQty = group.reduce((s, t) => s + t.quantity, 0);
    const totalPnl = group.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const exitPrice =
      totalQty > 0
        ? group.reduce((s, t) => s + (t.exit_price ?? 0) * t.quantity, 0) / totalQty
        : 0;
    const exitDate = group.reduce(
      (latest, t) => ((t.exit_date || "") > latest ? t.exit_date || "" : latest),
      ""
    );
    const slDiff =
      first.side === "LONG"
        ? first.entry_price - first.initial_stop_loss
        : first.initial_stop_loss - first.entry_price;
    const rr = slDiff > 0 ? totalPnl / (slDiff * totalQty) : undefined;

    return {
      ...first,
      quantity: totalQty,
      exit_price: Math.round(exitPrice * 100) / 100,
      exit_date: exitDate,
      pnl: Math.round(totalPnl * 100) / 100,
      rr: rr != null ? Math.round(rr * 100) / 100 : undefined,
      result_type: totalPnl > 0.01 ? "WIN" : totalPnl < -0.01 ? "LOSS" : "BE",
    };
  });
}
