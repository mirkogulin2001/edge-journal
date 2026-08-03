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
  return (
    <html lang="es">
      <body className="min-h-screen bg-bg text-text-main font-display antialiased">
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
