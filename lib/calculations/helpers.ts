import type { UserConfig } from "@/types/user";

export function curSym(config: UserConfig | undefined): string {
  return config?.currency === "ARS" ? "AR$" : "$";
}

export function fmtMoney(value: number, sym: string): string {
  const abs = Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return value < 0 ? `-${sym}${abs}` : `${sym}${abs}`;
}

export function fmtMoneySign(value: number, sym: string): string {
  const abs = Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return value < 0 ? `-${sym}${abs}` : `+${sym}${abs}`;
}

export function fmtMoney2(value: number, sym: string): string {
  const abs = Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value < 0 ? `-${sym}${abs}` : `${sym}${abs}`;
}

export function fmtPct(value: number, decimals = 2): string {
  return `${value.toFixed(decimals)}%`;
}

export const RESERVED_CONFIG_KEYS = new Set(["initial_balance", "currency"]);

export function getStrategyKeys(config: UserConfig | undefined): string[] {
  if (!config) return [];
  return Object.keys(config).filter((k) => !RESERVED_CONFIG_KEYS.has(k));
}
