"use client";

import { useState } from "react";

/* ------------------------------------------------------------------ */
/*  Accordion helper                                                   */
/* ------------------------------------------------------------------ */
function Accordion({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-border rounded">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-left text-sm font-semibold text-text-main tracking-wide hover:bg-row-odd transition-colors"
      >
        <span>{title}</span>
        <span
          className={`text-accent transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        >
          &#9662;
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 text-sm text-neutral leading-relaxed border-t border-border">
          {children}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Card wrapper                                                       */
/* ------------------------------------------------------------------ */
function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded-lg overflow-hidden">
      <div className="px-5 py-3 border-b border-border">
        <h3 className="text-xs font-bold text-accent tracking-[0.15em] uppercase">
          {title}
        </h3>
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Import table columns                                               */
/* ------------------------------------------------------------------ */
const IMPORT_COLUMNS = [
  { col: "SYMBOL", req: true, desc: "Ticker del activo (ej. AAPL, BTC-USD)" },
  { col: "SIDE", req: true, desc: "LONG o SHORT" },
  { col: "QTY / QUANTITY", req: true, desc: "Cantidad operada" },
  { col: "ENTRY_PRICE", req: true, desc: "Precio de entrada" },
  { col: "EXIT_PRICE", req: false, desc: "Precio de salida (si cerrada)" },
  { col: "INITIAL_STOP_LOSS", req: false, desc: "Stop loss inicial" },
  { col: "ENTRY_DATE", req: false, desc: "Fecha de entrada" },
  { col: "EXIT_DATE", req: false, desc: "Fecha de salida" },
  { col: "RESULTADO", req: false, desc: "WIN / LOSS / BE" },
];

/* ------------------------------------------------------------------ */
/*  Navigation guide entries                                           */
/* ------------------------------------------------------------------ */
const NAV_SECTIONS = [
  {
    title: "OPERATIVA",
    body: "Vista principal de posiciones abiertas. Muestra cada trade activo con su precio de entrada, stop loss, PnL en tiempo real y unidades de riesgo (RR). Desde aqui podes cerrar parcial o totalmente una posicion, ajustar el stop loss y agregar notas de salida.",
  },
  {
    title: "HISTORIAL",
    body: "Registro completo de operaciones cerradas. Incluye precio de entrada/salida, PnL realizado, RR, resultado (WIN/LOSS/BE), tags de estrategia y notas. Podes filtrar, ordenar y exportar a CSV.",
  },
  {
    title: "ANALYTICS",
    body: "Dashboard de metricas de performance: equity curve, drawdown, win rate, ratio R/B, esperanza matematica, distribucion de resultados y descomposicion por estrategia. Todas las metricas se recalculan sobre tus trades cerrados.",
  },
  {
    title: "SIMULADOR DE RIESGO",
    body: "Motor de Monte Carlo que genera miles de trayectorias simuladas a partir de tu distribucion historica de resultados. Calcula la probabilidad de ruina, drawdown esperado, y el criterio de Kelly para dimensionamiento optimo de posiciones.",
  },
  {
    title: "PERFORMANCE",
    body: "Curva de equity del portafolio incluyendo depositos, retiros y PnL acumulado. Compara tu rendimiento contra benchmarks y visualiza periodos de drawdown prolongado (time under water).",
  },
];

/* ------------------------------------------------------------------ */
/*  Glossary entries                                                   */
/* ------------------------------------------------------------------ */
const GLOSSARY = [
  {
    title: "PnL (Profit and Loss)",
    body: (
      <>
        <p>Ganancia o perdida realizada de una operacion.</p>
        <p className="mt-2 font-mono text-xs text-accent">
          LONG: PnL = (Exit - Entry) x Qty
        </p>
        <p className="font-mono text-xs text-accent">
          SHORT: PnL = (Entry - Exit) x Qty
        </p>
      </>
    ),
  },
  {
    title: "Unidad de Riesgo (RR)",
    body: (
      <>
        <p>
          Cuantas veces el riesgo inicial (distancia al stop loss) se capturo en
          la operacion. Permite comparar trades independientemente del tamanio de
          la posicion.
        </p>
        <p className="mt-2 font-mono text-xs text-accent">
          LONG: RR = (Exit - Entry) / (Entry - StopLoss)
        </p>
        <p className="font-mono text-xs text-accent">
          SHORT: RR = (Entry - Exit) / (StopLoss - Entry)
        </p>
      </>
    ),
  },
  {
    title: "Win Rate / Loss Rate",
    body: (
      <>
        <p>Proporcion de operaciones ganadoras y perdedoras sobre el total.</p>
        <p className="mt-2 font-mono text-xs text-accent">
          Win Rate = Wins / Total trades
        </p>
        <p className="font-mono text-xs text-accent">
          Loss Rate = Losses / Total trades
        </p>
      </>
    ),
  },
  {
    title: "Ratio R/B (Reward / Risk)",
    body: (
      <>
        <p>
          Relacion entre la ganancia media de las operaciones ganadoras y la
          perdida media de las perdedoras.
        </p>
        <p className="mt-2 font-mono text-xs text-accent">
          Ratio R/B = Avg(Win PnL) / |Avg(Loss PnL)|
        </p>
      </>
    ),
  },
  {
    title: "Esperanza Matematica",
    body: (
      <>
        <p>
          Valor esperado por operacion. Si es positivo, el sistema tiene edge
          estadistico a largo plazo.
        </p>
        <p className="mt-2 font-mono text-xs text-accent">
          E = (WinRate x AvgWin) - (LossRate x |AvgLoss|)
        </p>
      </>
    ),
  },
  {
    title: "Criterio de Kelly",
    body: (
      <>
        <p>
          Fraccion optima del capital a arriesgar por operacion para maximizar el
          crecimiento geometrico del portafolio. Se recomienda usar una fraccion
          de Kelly (tipicamente 1/4 o 1/2) para reducir la volatilidad.
        </p>
        <p className="mt-2 font-mono text-xs text-accent">
          Kelly% = WinRate - (LossRate / RatioPayout)
        </p>
      </>
    ),
  },
  {
    title: "Maximo Drawdown",
    body: (
      <p>
        La mayor caida porcentual desde un pico de equity hasta el valle
        subsiguiente. Mide la peor perdida historica que el sistema ha
        experimentado.
      </p>
    ),
  },
  {
    title: "Sharpe Ratio",
    body: (
      <>
        <p>
          Rendimiento ajustado por riesgo. Mide cuanto retorno adicional se
          obtiene por cada unidad de volatilidad asumida.
        </p>
        <p className="mt-2 font-mono text-xs text-accent">
          Sharpe = Mean(Returns) / Std(Returns)
        </p>
      </>
    ),
  },
  {
    title: "Sortino Ratio",
    body: (
      <>
        <p>
          Similar al Sharpe pero solo penaliza la volatilidad negativa
          (downside). Mas relevante para traders ya que no castiga la volatilidad
          al alza.
        </p>
        <p className="mt-2 font-mono text-xs text-accent">
          Sortino = Mean(Returns) / Std(Negative Returns)
        </p>
      </>
    ),
  },
  {
    title: "Calmar Ratio",
    body: (
      <>
        <p>
          Retorno anualizado dividido por el maximo drawdown. Indica cuanto
          retorno se genera por unidad de peor caida historica.
        </p>
        <p className="mt-2 font-mono text-xs text-accent">
          Calmar = Annual Return / |Max Drawdown|
        </p>
      </>
    ),
  },
  {
    title: "Alpha de Jensen & Beta",
    body: (
      <>
        <p>
          <span className="text-text-main font-medium">Beta</span> mide la
          sensibilidad del portafolio al mercado (benchmark).{" "}
          <span className="text-text-main font-medium">Alpha</span> es el
          exceso de retorno sobre lo esperado por el modelo CAPM.
        </p>
        <p className="mt-2 font-mono text-xs text-accent">
          Alpha = R_portfolio - [Rf + Beta x (R_market - Rf)]
        </p>
      </>
    ),
  },
  {
    title: "Time Under Water",
    body: (
      <p>
        Cantidad de dias (u operaciones) que el equity permanece por debajo de
        su ultimo maximo historico. Periodos prolongados indican dificultad para
        recuperar perdidas.
      </p>
    ),
  },
  {
    title: "Value at Risk (VaR 95%)",
    body: (
      <p>
        Perdida maxima esperada en un periodo dado con un 95% de confianza. Es
        decir, solo el 5% de los periodos se espera una perdida mayor a este
        valor.
      </p>
    ),
  },
  {
    title: "Riesgo de Ruina",
    body: (
      <p>
        Probabilidad de que el capital caiga a un nivel irrecuperable (tipicamente
        se define como perder el 50% o mas del capital). Se estima via simulacion
        de Monte Carlo sobre la distribucion historica de retornos.
      </p>
    ),
  },
];

/* ------------------------------------------------------------------ */
/*  Page component                                                     */
/* ------------------------------------------------------------------ */
export default function InfoPage() {
  return (
    <div className="max-w-7xl mx-auto py-8 px-4 space-y-8">
      {/* Header */}
      <h2 className="text-lg font-bold text-text-main tracking-wider">
        EDGE<span className="text-accent">JOURNAL</span>
        <span className="ml-3 text-xs font-normal text-neutral tracking-normal">
          Guia de referencia
        </span>
      </h2>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ---- LEFT COLUMN ---- */}
        <div className="space-y-6">
          {/* Objetivo del sitio */}
          <Card title="Objetivo del Sitio">
            <p className="text-sm text-neutral leading-relaxed mb-4">
              Edge Journal es una plataforma de trading journal disenada para
              traders que buscan medir, analizar y mejorar su operatoria de forma
              cuantitativa. Sus tres pilares son:
            </p>
            <ul className="space-y-3 text-sm text-neutral">
              <li className="flex items-start gap-3">
                <span className="mt-0.5 text-accent text-xs">&#9654;</span>
                <span>
                  <span className="text-text-main font-medium">
                    Registrar operaciones
                  </span>{" "}
                  realizadas y posiciones abiertas con precios en tiempo real.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-0.5 text-accent text-xs">&#9654;</span>
                <span>
                  <span className="text-text-main font-medium">
                    Analizar el desempeno
                  </span>{" "}
                  mediante indicadores de performance, equity curves y
                  descomposicion por estrategia.
                </span>
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-0.5 text-accent text-xs">&#9654;</span>
                <span>
                  <span className="text-text-main font-medium">
                    Determinar el riesgo optimo
                  </span>{" "}
                  con el criterio de Kelly y simulacion de Monte Carlo para
                  dimensionamiento de posiciones.
                </span>
              </li>
            </ul>
          </Card>

          {/* Importacion de Excel */}
          <Card title="Importacion de Excel">
            <p className="text-sm text-neutral leading-relaxed mb-4">
              Podes importar operaciones desde un archivo Excel (.xlsx) o CSV.
              El sistema reconoce las siguientes columnas:
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 pr-3 text-neutral font-semibold uppercase tracking-wider">
                      Columna
                    </th>
                    <th className="text-center py-2 px-3 text-neutral font-semibold uppercase tracking-wider">
                      Req.
                    </th>
                    <th className="text-left py-2 pl-3 text-neutral font-semibold uppercase tracking-wider">
                      Descripcion
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {IMPORT_COLUMNS.map((c) => (
                    <tr
                      key={c.col}
                      className="border-b border-border/50 last:border-0"
                    >
                      <td className="py-2 pr-3 font-mono text-accent whitespace-nowrap">
                        {c.col}
                      </td>
                      <td className="py-2 px-3 text-center">
                        {c.req ? (
                          <span className="text-accent font-bold">*</span>
                        ) : (
                          <span className="text-border">-</span>
                        )}
                      </td>
                      <td className="py-2 pl-3 text-neutral">{c.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-xs text-neutral/70 leading-relaxed">
              Las columnas adicionales que no esten en esta lista se importan
              automaticamente como{" "}
              <span className="text-accent">parametros de estrategia</span> y se
              almacenan en el campo de tags de cada operacion.
            </p>
          </Card>
        </div>

        {/* ---- RIGHT COLUMN ---- */}
        <div className="space-y-6">
          {/* Guia de navegacion */}
          <Card title="Guia de Navegacion">
            <p className="text-sm text-neutral leading-relaxed mb-4">
              El journal se organiza en pestanas. Hace click en cada seccion para
              ver mas detalles:
            </p>
            <div className="space-y-2">
              {NAV_SECTIONS.map((s) => (
                <Accordion key={s.title} title={s.title}>
                  <p className="pt-3">{s.body}</p>
                </Accordion>
              ))}
            </div>
          </Card>

          {/* Glosario y formulas */}
          <Card title="Glosario y Formulas">
            <p className="text-sm text-neutral leading-relaxed mb-4">
              Referencia rapida de las metricas y formulas utilizadas en el
              journal:
            </p>
            <div className="space-y-2">
              {GLOSSARY.map((g) => (
                <Accordion key={g.title} title={g.title}>
                  <div className="pt-3">{g.body}</div>
                </Accordion>
              ))}
            </div>
          </Card>
        </div>
      </div>

      {/* ---- FOOTER ---- */}
      <footer className="border-t border-border pt-6 pb-2">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-neutral">
          <div className="flex flex-col sm:flex-row items-center gap-2 sm:gap-4">
            <span className="text-text-main font-medium">
              Desarrollado por Mirko Gulin
            </span>
            <a
              href="mailto:mirkogulin2001@gmail.com"
              className="text-accent hover:underline"
            >
              mirkogulin2001@gmail.com
            </a>
            <a
              href="https://edge-terminal.streamlit.app/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent hover:underline"
            >
              Edge Terminal
            </a>
          </div>
          <span className="text-border">&copy; 2026 Edge Journal</span>
        </div>
      </footer>
    </div>
  );
}
