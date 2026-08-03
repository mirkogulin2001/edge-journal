export interface DailyPortfolioRow {
  date: string;
  total_value: number;
  cash: number;
  equity_value: number;
  external_flow: number;
  daily_return: number;
  cumulative_return: number;
}

export interface PerformanceResult {
  daily: DailyPortfolioRow[];
  kpis: PerformanceKPIs;
  benchmark: { date: string; norm_return: number }[];
}

export interface PerformanceKPIs {
  initial_balance: number;
  period_start_value: number;
  total_end: number;
  total_pnl: number;
  total_return: number;
  total_deposits: number;
  total_withdrawals: number;
  max_dd: number;
  current_dd: number;
  total_return_spy: number;
  max_dd_spy: number;
  sharpe_port: number;
  sharpe_spy: number;
  sortino_port: number;
  sortino_spy: number;
  calmar_port: number;
  calmar_spy: number;
  alpha: number;
  beta: number;
  max_tuw: number;
  avg_tuw: number;
  period_label: string;
  bench_name: string;
}

export interface MonteCarloResult {
  kpis: {
    win_rate: number;
    ratio_rb: number;
    kelly_optimal: number;
    risk_used: number;
    mean_ret: number;
    med_ret: number;
    std_ret: number;
    var_95: number;
    ruin_pct: number;
  };
  ret_histogram: { bins: number[]; counts: number[] };
  dd_histogram: { bins: number[]; counts: number[] };
  sample_curves: number[][];
  median_curve: number[];
  kelly_curve: { f: number[]; g: number[]; markers: { f: number; g: number; label: string; is_full: boolean }[] };
  stats_lines: {
    mean_ret: number;
    med_ret: number;
    mean_dd: number;
    med_dd: number;
    p05_dd: number;
  };
}
