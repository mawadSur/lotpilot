import type { Metadata } from "next";
import { Plus_Jakarta_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// Plus Jakarta Sans — UI Pro Max design-system recommendation for
// "friendly + modern SaaS" mood (B2B, dashboards, productivity). Five
// weights cover h1 → body → metadata. `display: swap` so FOIT doesn't
// hold up first paint on the landing.
const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

// Monospace for keyword tags and number-tabular pricing.
const mono = JetBrains_Mono({
  variable: "--font-jb-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://lotpilot-chi.vercel.app"),
  title:
    "LotPilot — Bilingual AI sales assistant for independent used-car dealers",
  description:
    "Answers every Marketplace, SMS, and WhatsApp lead in 60 seconds — in English or Spanish, in your voice. Books test drives, sends consent-compliant follow-ups, and tells you what to buy at this weekend's auction.",
  applicationName: "LotPilot",
  authors: [{ name: "LotPilot" }],
  keywords: [
    "AI sales assistant",
    "used car dealer software",
    "Facebook Marketplace automation",
    "bilingual auto sales",
    "Spanish dealer chat",
    "TCPA compliant SMS",
    "Calendly test drive",
    "WhatsApp Business auto dealer",
  ],
  openGraph: {
    title: "LotPilot — Bilingual AI sales assistant for independent dealers",
    description:
      "Every Marketplace lead, answered in 60 seconds. English or Spanish. TCPA-compliant. Built by a 10-year used-car salesperson.",
    siteName: "LotPilot",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "LotPilot — Bilingual AI sales assistant for used-car dealers",
    description:
      "Every Marketplace lead, answered in 60 seconds. EN/ES. TCPA-compliant.",
  },
  robots: { index: true, follow: true },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${jakarta.variable} ${mono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-[var(--surface-base)] text-[var(--ink-strong)]">
        {children}
      </body>
    </html>
  );
}
