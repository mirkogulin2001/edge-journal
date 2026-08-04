import type { Metadata } from "next";
import { SessionProvider } from "@/hooks/useSession";
import { EnvScript } from "@/components/EnvScript";
import "./globals.css";

export const metadata: Metadata = {
  title: "Edge Journal",
  description: "Trading journal for serious traders",
};

export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <head>
        <EnvScript />
      </head>
      <body className="min-h-screen bg-bg text-text-main font-display antialiased">
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
