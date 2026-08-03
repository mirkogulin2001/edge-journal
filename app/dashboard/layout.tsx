"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import Link from "next/link";
import { useSession } from "@/hooks/useSession";

const TABS = [
  { id: "operativa", label: "OPERATIVA" },
  { id: "historial", label: "HISTORIAL" },
  { id: "analytics", label: "ANALYTICS" },
  { id: "montecarlo", label: "MONTECARLO" },
  { id: "performance", label: "PERFORMANCE" },
  { id: "info", label: "INFO" },
] as const;

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const { session, logout } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!session) router.replace("/login");
  }, [session, router]);

  if (!session) return null;

  const activeTab = pathname.split("/").pop() || "operativa";

  return (
    <div className="min-h-screen bg-bg">
      {/* Header */}
      <header className="bg-card border-b border-border px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <h1 className="text-lg font-bold tracking-wider text-text-main">
            EDGE<span className="text-accent">JOURNAL</span>
          </h1>
          <span className="text-neutral text-sm hidden sm:block">
            {session.full_name}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => {
              logout();
              router.replace("/login");
            }}
            className="text-neutral hover:text-text-main text-sm font-semibold tracking-wide transition"
          >
            SALIR
          </button>
        </div>
      </header>

      {/* Tab bar */}
      <nav className="bg-bg border-b border-border overflow-x-auto">
        <div className="flex">
          {TABS.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <Link
                key={tab.id}
                href={`/dashboard/${tab.id}`}
                className={`px-4 py-3.5 text-sm font-semibold tracking-wider whitespace-nowrap transition-colors ${
                  isActive
                    ? "text-text-main border-b-[3px] border-accent"
                    : "text-neutral border-b border-border hover:text-text-main"
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Page content */}
      <main className="p-6">{children}</main>
    </div>
  );
}
