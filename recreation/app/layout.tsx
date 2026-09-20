import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ledge Protocol",
  description: "Run the fixed five-call ledge-v2 replication protocol through OpenRouter.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
