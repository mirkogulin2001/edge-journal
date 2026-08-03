"use client";

export default function InfoPage() {
  return (
    <div className="max-w-2xl mx-auto py-10 space-y-6">
      <h2 className="text-lg font-bold text-text-main tracking-wider">
        EDGE<span className="text-accent">JOURNAL</span>
      </h2>
      <div className="bg-card border border-border rounded-lg p-6 space-y-4 text-sm text-neutral leading-relaxed">
        <p>
          Edge Journal es una plataforma de trading journal diseñada para traders
          que buscan medir, analizar y mejorar su operatoria de forma
          cuantitativa.
        </p>
        <p>
          Registrá tus operaciones, medí tu edge con métricas de sistema,
          simulá escenarios con Monte Carlo y mejorá tus análisis.
        </p>
        <p className="text-border text-xs">© 2026 Edge Journal</p>
      </div>
    </div>
  );
}
