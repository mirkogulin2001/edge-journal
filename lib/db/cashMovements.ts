import { getSupabase } from "@/lib/supabase/client";
import type { CashMovement } from "@/types/cashMovement";

export async function getCashMovements(
  username: string
): Promise<CashMovement[]> {
  const { data, error } = await getSupabase()
    .from("cash_movements")
    .select("*")
    .eq("username", username)
    .order("movement_date", { ascending: true });
  if (error) { console.error("getCashMovements:", error); return []; }
  return data as CashMovement[];
}

export async function addCashMovement(
  username: string,
  movementDate: string,
  amount: number,
  movementType: "APORTE" | "RETIRO"
): Promise<boolean> {
  const { error } = await getSupabase().from("cash_movements").insert({
    username,
    movement_date: movementDate,
    amount,
    movement_type: movementType,
  });
  return !error;
}

export async function deleteCashMovement(id: number): Promise<boolean> {
  const { error } = await getSupabase()
    .from("cash_movements")
    .delete()
    .eq("id", id);
  return !error;
}
