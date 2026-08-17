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
  const [showTerms, setShowTerms] = useState(false);

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
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowTerms(true);
                    }}
                    className="text-accent underline hover:text-accent/80 transition"
                  >
                    Términos y Condiciones
                  </button>{" "}
                  de Edge Journal
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

        {/* Terms modal */}
        {showTerms && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] px-4">
            <div className="bg-card border border-border rounded-lg w-full max-w-lg shadow-2xl max-h-[80vh] flex flex-col">
              <div className="flex items-center justify-between p-4 border-b border-border">
                <h2 className="text-lg font-bold text-text-main tracking-wide">
                  TÉRMINOS Y CONDICIONES
                </h2>
                <button
                  onClick={() => setShowTerms(false)}
                  className="text-neutral hover:text-text-main text-lg"
                >
                  ✕
                </button>
              </div>
              <div className="p-4 overflow-y-auto text-sm text-neutral space-y-3">
                <p className="text-xs text-neutral/60">
                  Última actualización: julio 2026
                </p>
                <h3 className="font-bold text-text-main">1. Aceptación</h3>
                <p>
                  Al crear una cuenta en Edge Journal aceptás estos términos. Si
                  no estás de acuerdo, no utilices la plataforma.
                </p>
                <h3 className="font-bold text-text-main">
                  2. Naturaleza del servicio
                </h3>
                <p>
                  Edge Journal es una herramienta de registro y análisis de
                  operaciones bursátiles con fines informativos y educativos. NO
                  constituye asesoramiento financiero, recomendación de inversión
                  ni oferta de compra o venta de ningún instrumento. Toda
                  decisión de inversión es exclusiva responsabilidad del usuario.
                </p>
                <h3 className="font-bold text-text-main">
                  3. Datos que registrás
                </h3>
                <p>
                  Para funcionar, la plataforma almacena la información que vos
                  cargás: usuario, nombre, capital de referencia, operaciones
                  (activos, precios, cantidades, fechas, notas), aportes y
                  retiros, y parámetros de estrategia. Esta información se
                  guarda en una base de datos gestionada (Supabase) y se usa
                  únicamente para brindarte las funcionalidades de la plataforma.
                </p>
                <h3 className="font-bold text-text-main">4. Privacidad</h3>
                <p>
                  Tus datos no se venden, alquilan ni comparten con terceros.
                  Solo son accesibles desde tu cuenta. Podés solicitar la
                  eliminación completa de tu cuenta y sus datos en cualquier
                  momento.
                </p>
                <h3 className="font-bold text-text-main">
                  5. Datos de mercado
                </h3>
                <p>
                  Los precios y cotizaciones provienen de fuentes de terceros
                  (Yahoo Finance) y pueden contener demoras, errores u
                  omisiones. No se garantiza su exactitud ni disponibilidad. Los
                  cálculos de rendimiento derivados son estimaciones y pueden
                  diferir de los valores oficiales de tu broker.
                </p>
                <h3 className="font-bold text-text-main">
                  6. Limitación de responsabilidad
                </h3>
                <p>
                  La plataforma se ofrece &quot;tal cual&quot;, sin garantías de
                  ningún tipo. No nos responsabilizamos por pérdidas o daños
                  derivados del uso de la plataforma, de decisiones de inversión
                  tomadas en base a su información, ni por interrupciones del
                  servicio o pérdida de datos.
                </p>
                <h3 className="font-bold text-text-main">
                  7. Seguridad de la cuenta
                </h3>
                <p>
                  Sos responsable de mantener la confidencialidad de tus
                  credenciales. Evitá reutilizar contraseñas de otros servicios.
                </p>
                <h3 className="font-bold text-text-main">8. Modificaciones</h3>
                <p>
                  Estos términos pueden actualizarse. El uso continuado de la
                  plataforma tras una modificación implica su aceptación.
                </p>
              </div>
              <div className="p-4 border-t border-border">
                <button
                  onClick={() => setShowTerms(false)}
                  className="w-full py-2 border border-border text-neutral font-bold rounded hover:text-text-main transition"
                >
                  CERRAR
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
