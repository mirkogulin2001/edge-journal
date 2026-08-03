"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import type { SessionData, UserConfig } from "@/types/user";

interface SessionCtx {
  session: SessionData | null;
  login: (session: SessionData) => void;
  logout: () => void;
  updateConfig: (config: UserConfig) => void;
}

const Ctx = createContext<SessionCtx>({
  session: null,
  login: () => {},
  logout: () => {},
  updateConfig: () => {},
});

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionData | null>(() => {
    if (typeof window === "undefined") return null;
    const stored = localStorage.getItem("ej-session");
    return stored ? JSON.parse(stored) : null;
  });

  const login = useCallback((data: SessionData) => {
    setSession(data);
    localStorage.setItem("ej-session", JSON.stringify(data));
  }, []);

  const logout = useCallback(() => {
    setSession(null);
    localStorage.removeItem("ej-session");
  }, []);

  const updateConfig = useCallback(
    (config: UserConfig) => {
      setSession((prev) => {
        if (!prev) return prev;
        const next = { ...prev, config };
        localStorage.setItem("ej-session", JSON.stringify(next));
        return next;
      });
    },
    []
  );

  return (
    <Ctx.Provider value={{ session, login, logout, updateConfig }}>
      {children}
    </Ctx.Provider>
  );
}

export function useSession() {
  return useContext(Ctx);
}
