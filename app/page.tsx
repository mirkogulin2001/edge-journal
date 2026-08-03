"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/hooks/useSession";

export default function Home() {
  const { session } = useSession();
  const router = useRouter();

  useEffect(() => {
    router.replace(session ? "/dashboard/operativa" : "/login");
  }, [session, router]);

  return null;
}
