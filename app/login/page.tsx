"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/hooks/useSession";
import { getUser, registerUser } from "@/lib/db/users";

export default function LoginPage() {
  const { login } = useSession();
  const router = useRouter();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const [showRegister, setShowRegister] = useState(false);
  const [regUser, setRegUser] = useState("");
  const [regPass, setRegPass] = useState("");
  const [regName, setRegName] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regMsg, setRegMsg] = useState("");
  const [regLoading, setRegLoading] = useState(false);
  const [tcAccepted, setTcAccepted] = useState(false);

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const user = await getUser(username);
      if (!user) {
        setError("Usuario no encontrado");
      } else if (user.password_hash !== password) {
        setError("Contraseña incorrecta");
      } else {
        login({
          user: user.username,
          full_name: user.full_name,
          config: user.config || {},
        });
        router.replace("/dashboard/operativa");
      }
    } catch {
      setError("Error de conexión");
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e: FormEvent) {
    e.preventDefault();
    if (!tcAccepted) {
      setRegMsg("Debés aceptar los Términos y Condiciones");
      return;
    }
    setRegMsg("");
    setRegLoading(true);
    try {
      const result = await registerUser(regUser, regPass, regName, regEmail);
      setRegMsg(result.message);
      if (result.ok) {
        setTimeout(() => setShowRegister(false), 1500);
      }
    } catch {
      setRegMsg("Error de conexión");
    } finally {
      setRegLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg px-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold tracking-wider text-text-main">
            EDGE<span className="text-accent">JOURNAL</span>
          </h1>
          <p className="text-neutral text-sm mt-2 tracking-wide">
            TRADING JOURNAL
          </p>
        </div>

        {/* Login form */}
        <form
          onSubmit={handleLogin}
          className="bg-card border border-border rounded-lg p-6 shadow-xl"
        >
          <input
            type="text"
            placeholder="Usuario"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full bg-bg border border-border rounded px-4 py-3 text-text-main placeholder-neutral mb-3 focus:border-accent focus:ring-1 focus:ring-accent/30 outline-none transition"
          />
          <input
            type="password"
            placeholder="Contraseña"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-bg border border-border rounded px-4 py-3 text-text-main placeholder-neutral mb-4 focus:border-accent focus:ring-1 focus:ring-accent/30 outline-none transition"
          />
          {error && (
            <p className="text-negative text-sm mb-3 font-semibold">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-text-main text-bg font-bold py-3 rounded hover:-translate-y-0.5 active:translate-y-0 transition disabled:opacity-50"
          >
            {loading ? "INGRESANDO..." : "INGRESAR"}
          </button>

          <div className="flex justify-between mt-4 text-sm">
            <button
              type="button"
              onClick={() => setShowRegister(true)}
              className="text-accent hover:underline"
            >
              Crear cuenta
            </button>
            <button type="button" className="text-neutral hover:text-text-main">
              Recuperar contraseña
            </button>
          </div>
        </form>

        {/* Register modal */}
        {showRegister && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-4">
            <form
              onSubmit={handleRegister}
              className="bg-card border border-border rounded-lg p-6 w-full max-w-md shadow-2xl"
            >
              <h2 className="text-lg font-bold text-text-main mb-4 tracking-wide">
                REGISTRO
              </h2>
              <input
                type="text"
                placeholder="Usuario"
                value={regUser}
                onChange={(e) => setRegUser(e.target.value)}
                className="w-full bg-bg border border-border rounded px-4 py-2.5 text-text-main placeholder-neutral mb-3 focus:border-accent outline-none transition"
              />
              <input
                type="text"
                placeholder="Nombre completo"
                value={regName}
                onChange={(e) => setRegName(e.target.value)}
                className="w-full bg-bg border border-border rounded px-4 py-2.5 text-text-main placeholder-neutral mb-3 focus:border-accent outline-none transition"
              />
              <input
                type="email"
                placeholder="Email"
                value={regEmail}
                onChange={(e) => setRegEmail(e.target.value)}
                className="w-full bg-bg border border-border rounded px-4 py-2.5 text-text-main placeholder-neutral mb-3 focus:border-accent outline-none transition"
              />
              <input
                type="password"
                placeholder="Contraseña"
                value={regPass}
                onChange={(e) => setRegPass(e.target.value)}
                className="w-full bg-bg border border-border rounded px-4 py-2.5 text-text-main placeholder-neutral mb-4 focus:border-accent outline-none transition"
              />
              <label className="flex items-start gap-2 text-sm text-neutral mb-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={tcAccepted}
                  onChange={(e) => setTcAccepted(e.target.checked)}
                  className="mt-0.5 accent-accent"
                />
                <span>
                  Acepto los{" "}
                  <span className="text-accent">Términos y Condiciones</span> de
                  Edge Journal
                </span>
              </label>
              {regMsg && (
                <p
                  className={`text-sm mb-3 font-semibold ${
                    regMsg.includes("creado")
                      ? "text-accent"
                      : "text-negative"
                  }`}
                >
                  {regMsg}
                </p>
              )}
              <div className="flex gap-3">
                <button
                  type="submit"
                  disabled={regLoading}
                  className="flex-1 bg-text-main text-bg font-bold py-2.5 rounded hover:-translate-y-0.5 transition disabled:opacity-50"
                >
                  {regLoading ? "REGISTRANDO..." : "REGISTRAR"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowRegister(false)}
                  className="px-4 py-2.5 border border-border text-neutral rounded hover:text-text-main transition"
                >
                  CERRAR
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
