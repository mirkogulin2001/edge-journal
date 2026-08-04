import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _supabase: SupabaseClient | null = null;

function getEnv(key: string): string {
  if (typeof window !== "undefined" && (window as any).__ENV?.[key]) {
    return (window as any).__ENV[key];
  }
  return process.env[key] || "";
}

export function getSupabase(): SupabaseClient {
  if (!_supabase) {
    const url = getEnv("NEXT_PUBLIC_SUPABASE_URL");
    const key = getEnv("NEXT_PUBLIC_SUPABASE_KEY");
    if (!url || !key) {
      throw new Error("Supabase credentials not configured");
    }
    _supabase = createClient(url, key);
  }
  return _supabase;
}
