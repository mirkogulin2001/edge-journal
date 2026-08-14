"use client";

import { useState, useEffect, useCallback } from "react";
import { useSession } from "@/hooks/useSession";
import { RESERVED_CONFIG_KEYS } from "@/lib/calculations/helpers";
import type { UserConfig } from "@/types/user";

interface ParamRow {
  key: string;
  values: string;
}

function configToRows(config: UserConfig): ParamRow[] {
  return Object.keys(config)
    .filter((k) => !RESERVED_CONFIG_KEYS.has(k))
    .map((k) => ({
      key: k,
      values: Array.isArray(config[k])
        ? (config[k] as string[]).join(", ")
        : typeof config[k] === "string"
          ? (config[k] as string)
          : "",
    }));
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function ConfigModal({ open, onClose }: Props) {
  const { session, updateConfig } = useSession();
  const config = session?.config || {};

  const [rows, setRows] = useState<ParamRow[]>([]);
  const [currency, setCurrency] = useState<"USD" | "ARS">("USD");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (open) {
      setRows(configToRows(config));
      setCurrency(config.currency || "USD");
      setMsg("");
    }
  }, [open, config]);

  const handleAddRow = useCallback(() => {
    setRows((prev) => [...prev, { key: "", values: "" }]);
  }, []);

  const handleRemoveRow = useCallback((index: number) => {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleChangeKey = useCallback((index: number, value: string) => {
    setRows((prev) =>
      prev.map((r, i) => (i === index ? { ...r, key: value } : r))
    );
  }, []);

  const handleChangeValues = useCallback((index: number, value: string) => {
    setRows((prev) =>
      prev.map((r, i) => (i === index ? { ...r, values: value } : r))
    );
  }, []);

  const handleSave = useCallback(async () => {
    const validRows = rows.filter((r) => r.key.trim() !== "");
    const dupes = new Set<string>();
    for (const r of validRows) {
      if (dupes.has(r.key.trim())) {
        setMsg("Hay parametros duplicados");
        return;
      }
      dupes.add(r.key.trim());
    }

    const newConfig: UserConfig = {
      initial_balance: config.initial_balance,
      currency,
    };
    for (const r of validRows) {
      newConfig[r.key.trim()] = r.values.trim();
    }

    setSaving(true);
    try {
      await updateConfig(newConfig);
      setMsg("Configuracion guardada");
      setTimeout(() => onClose(), 800);
    } catch {
      setMsg("Error al guardar");
    } finally {
      setSaving(false);
    }
  }, [rows, currency, config.initial_balance, updateConfig, onClose]);

  if (!open) return null;

  const INPUT =
    "bg-bg border border-border rounded px-3 py-2 text-text-main text-sm focus:border-accent outline-none transition w-full";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative bg-card border border-border rounded-lg shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-bold tracking-wider text-text-main">
            CONFIGURACION DE PARAMETROS
          </h2>
          <button
            onClick={onClose}
            className="text-neutral hover:text-text-main text-lg leading-none transition"
          >
            &times;
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Currency */}
          <div>
            <label className="block text-xs text-neutral font-bold mb-2 tracking-wider">
              MONEDA DE LA CUENTA
            </label>
            <div className="flex border border-border rounded overflow-hidden w-fit">
              {(["USD", "ARS"] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setCurrency(c)}
                  className={`px-5 py-2 text-sm font-bold transition ${
                    currency === c
                      ? "bg-accent/20 text-accent border-accent"
                      : "text-neutral hover:text-text-main"
                  }`}
                >
                  {c === "USD" ? "USD ($)" : "ARS (AR$)"}
                </button>
              ))}
            </div>
          </div>

          {/* Strategy params */}
          <div>
            <label className="block text-xs text-neutral font-bold mb-2 tracking-wider">
              PARAMETROS DE ESTRATEGIA
            </label>
            <p className="text-xs text-neutral mb-3">
              Defini los parametros que vas a usar al cargar operaciones en la
              pestaña Operativa. Cada parametro tiene opciones separadas por
              coma.
            </p>

            <div className="space-y-2">
              {rows.map((row, i) => (
                <div key={i} className="flex gap-2 items-start">
                  <input
                    placeholder="Nombre (ej: Tipo)"
                    value={row.key}
                    onChange={(e) => handleChangeKey(i, e.target.value)}
                    className={`${INPUT} flex-[2]`}
                  />
                  <input
                    placeholder="Opciones (ej: Trend, Reversal, Breakout)"
                    value={row.values}
                    onChange={(e) => handleChangeValues(i, e.target.value)}
                    className={`${INPUT} flex-[3]`}
                  />
                  <button
                    onClick={() => handleRemoveRow(i)}
                    className="text-neutral hover:text-negative text-lg leading-none px-2 py-2 transition shrink-0"
                    title="Eliminar"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>

            <button
              onClick={handleAddRow}
              className="mt-3 text-xs text-accent font-bold hover:text-accent/80 transition tracking-wider"
            >
              + AGREGAR PARAMETRO
            </button>
          </div>

          {/* Example */}
          {rows.length === 0 && (
            <div className="text-xs text-neutral border border-border rounded p-3 bg-bg">
              <p className="font-bold mb-1">Ejemplo:</p>
              <p>
                Parametro: <span className="text-text-main">Tipo</span> →
                Opciones:{" "}
                <span className="text-text-main">
                  Trend, Reversal, Breakout
                </span>
              </p>
              <p className="mt-1">
                Esto agrega un selector &quot;Tipo&quot; en el formulario de
                nueva operacion con esas tres opciones.
              </p>
            </div>
          )}

          {/* Message */}
          {msg && (
            <p
              className={`text-xs font-bold ${msg.includes("Error") || msg.includes("duplicado") ? "text-negative" : "text-accent"}`}
            >
              {msg}
            </p>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 bg-text-main text-bg font-bold py-2.5 rounded hover:-translate-y-0.5 transition text-sm disabled:opacity-50"
            >
              {saving ? "GUARDANDO..." : "GUARDAR"}
            </button>
            <button
              onClick={onClose}
              className="px-6 py-2.5 text-neutral hover:text-text-main font-bold text-sm transition border border-border rounded"
            >
              CANCELAR
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
