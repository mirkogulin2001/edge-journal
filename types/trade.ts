export interface Trade {
  id: number;
  username: string;
  symbol: string;
  side: "LONG" | "SHORT";
  entry_price: number;
  quantity: number;
  entry_date: string;
  initial_stop_loss: number;
  current_stop_loss: number;
  tags: Record<string, string> | null;
  entry_notes: string;
  status: "OPEN" | "CLOSED";
  exit_price?: number;
  exit_date?: string;
  pnl?: number;
  rr?: number;
  result_type?: "WIN" | "LOSS" | "BE";
  exit_notes?: string;
  created_at?: string;
}

export interface OpenTradeWithMetrics extends Trade {
  current_price: number;
  unrealized_pnl: number;
  open_risk: number;
  unrealized_pnl_pct: number;
  open_risk_pct: number;
}

export interface ClosedTradeWithPct extends Trade {
  pnl_pct: number;
  visual_id?: number;
}
