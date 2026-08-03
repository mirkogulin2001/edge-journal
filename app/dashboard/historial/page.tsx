"use client";

import { useSession } from "@/hooks/useSession";

export default function HistorialPage() {
  const { session } = useSession();
  return (
    <div className="text-center py-20">
      <h2 className="text-lg font-bold text-text-main tracking-wider mb-2">HISTORIAL</h2>
      <p className="text-neutral text-sm">En desarrollo — próxima fase</p>
    </div>
  );
}
