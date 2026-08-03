export interface UserConfig {
  initial_balance?: number;
  currency?: "USD" | "ARS";
  [key: string]: unknown;
}

export interface User {
  username: string;
  password_hash: string;
  full_name: string;
  email: string;
  config: UserConfig;
}

export interface SessionData {
  user: string;
  full_name: string;
  config: UserConfig;
}
