export interface CashMovement {
  id: number;
  username: string;
  movement_date: string;
  amount: number;
  movement_type: "APORTE" | "RETIRO";
}
