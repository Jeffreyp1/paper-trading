import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Stocky",
  description: "Stocky paper-trading dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-bg text-white">{children}</body>
    </html>
  );
}
