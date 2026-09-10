import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
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

const canonical = process.env.BETTER_AUTH_URL?.trim() || site.url;

export const metadata: Metadata = {
  // Without this, every relative URL in the metadata below resolves against
  // localhost at build time and ships that way.
  metadataBase: new URL(canonical),
  alternates: { canonical: "/" },
  title: "Docxy · Docs that keep up with your code",
  description: site.description,
  keywords: [
    "documentation github app",
    "automated changelog",
    "docs github action",
    "ai documentation agent",
    "multi-agent",
    "Mastra",
    "Daytona",
    "Nebius Token Factory",
    "docs drift",
  ],
  openGraph: {
    title: "Docxy · Docs that keep up with your code",
    description: site.description,
    type: "website",
    siteName: "Docxy",
    url: canonical,
  },
  twitter: {
    card: "summary_large_image",
    title: "Docxy · Docs that keep up with your code",
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
      <head>
        {/*
          Runs before first paint: reads the saved choice and, for "system",
          the OS setting. Only ever adds or removes one class, so a failure
          (private mode, storage blocked) leaves the default dark shell.
        */}
        <Script id="theme-init" strategy="beforeInteractive">
          {`try{var t=localStorage.getItem('docxy-theme')||'system';var l=t==='light'||(t==='system'&&window.matchMedia('(prefers-color-scheme: light)').matches);document.documentElement.classList.toggle('theme-light',l)}catch(e){}`}
        </Script>
      </head>
      <body className="antialiased bg-white font-sans" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
