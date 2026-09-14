import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Colour Mode Converter — RGB → CMYK @ 600 DPI",
  description: "Professional RGB → CMYK image converter for prepress and print. Genuine ICC-managed CMYK JPEG output at 600 × 600 DPI with exact pure colour mappings and validation.",
  keywords: ["CMYK", "RGB", "600 DPI", "prepress", "ICC", "colour management", "JPEG", "image converter"],
  authors: [{ name: "Colour Mode Converter" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Colour Mode Converter",
    description: "RGB → CMYK conversion at 600 DPI with ICC colour management.",
    url: "https://chat.z.ai",
    siteName: "Colour Mode Converter",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Colour Mode Converter",
    description: "RGB → CMYK conversion at 600 DPI with ICC colour management.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
