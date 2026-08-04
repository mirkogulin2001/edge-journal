import type { Metadata } from "next";
import { SessionProvider } from "@/hooks/useSession";
import "./globals.css";

export const metadata: Metadata = {
  title: "Edge Journal",
  description: "Trading journal for serious traders",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const envScript = `window.__ENV=${JSON.stringify({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "",
    NEXT_PUBLIC_SUPABASE_KEY: process.env.NEXT_PUBLIC_SUPABASE_KEY || process.env.SUPABASE_KEY || "",
  })};`;

  return (
    <html lang="es">
      <body className="min-h-screen bg-bg text-text-main font-display antialiased">
        <script dangerouslySetInnerHTML={{ __html: envScript }} />
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
