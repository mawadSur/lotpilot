import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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
  title: "LotPilot — Every Marketplace lead, answered in 60 seconds",
  description:
    "The bilingual AI sales assistant for independent used-car dealers. Replies to every Facebook Marketplace, SMS, and web lead in under 60 seconds. Books test drives 24/7, in English or Spanish.",
  openGraph: {
    title: "LotPilot — Every Marketplace lead, answered in 60 seconds",
    description:
      "Bilingual AI sales assistant for independent used-car dealers. 60-second responses, test drives booked, 24/7.",
    siteName: "LotPilot",
    type: "website",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
