import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { site } from "@/lib/site";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Docxy · Docs that write themselves",
  description: site.description,
  keywords: [
    "documentation github app",
    "automated changelog",
    "docs github action",
    "ai documentation agent",
    "multi-agent",
    "TrueForge",
    "Nebius Token Factory",
    "docs drift",
  ],
  openGraph: {
    title: "Docxy · Docs that write themselves",
    description: site.description,
    type: "website",
    siteName: "Docxy",
  },
  twitter: {
    card: "summary_large_image",
    title: "Docxy · Docs that write themselves",
    description: site.description,
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // Browser extensions inject attributes onto <html> and <body> before React
    // hydrates (assetsnip, Grammarly, password managers). Those are the only
    // mismatches expected here, and suppressing at this level does not reach
    // any component below.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full scroll-smooth`}
      suppressHydrationWarning
    >
      <body className="antialiased bg-white font-sans" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
