import { getSupabase } from "@/lib/supabase/client";
import type { User, UserConfig } from "@/types/user";

export async function getUser(username: string): Promise<User | null> {
  const { data, error } = await getSupabase()
    .from("users")
    .select("*")
    .eq("username", username)
    .single();
  if (error || !data) return null;
  return data as User;
}

export async function registerUser(
  username: string,
  password: string,
  fullName: string,
  email: string = ""
): Promise<{ ok: boolean; message: string }> {
  const existing = await getUser(username);
  if (existing) return { ok: false, message: "Usuario ya existe" };

  const { error } = await getSupabase().from("users").insert({
    username,
    password_hash: password,
    full_name: fullName,
    email: email.trim().toLowerCase(),
    config: {},
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Usuario creado" };
}

export async function updateUserPassword(
  username: string,
  newPassword: string
): Promise<boolean> {
  const { error } = await getSupabase()
    .from("users")
    .update({ password_hash: newPassword })
    .eq("username", username);
  return !error;
}

export async function updateUserConfig(
  username: string,
  config: UserConfig
): Promise<boolean> {
  const { error } = await getSupabase()
    .from("users")
    .update({ config })
    .eq("username", username);
  return !error;
}
