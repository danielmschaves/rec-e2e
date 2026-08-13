import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Northwind — Recruitment",
  description:
    "End-to-end recruitment tracking with automatic Gmail, Calendar and Drive sync.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
