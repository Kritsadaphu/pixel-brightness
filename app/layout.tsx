import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const title = "Pixel Brightness — Windows Spatial Projection Processor";
const description = "Windows Web Control for Arena composition input, automatic multi-projector geometry, blending, masks, black uniformity and DXGI output.";

export const metadata: Metadata = {
  title,
  description,
  openGraph: { type: "website", title, description },
  twitter: { card: "summary_large_image", title, description },
};

async function requestOrigin() {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",", 1)[0]?.trim();
  const requestHost = forwardedHost || requestHeaders.get("host") || "localhost:3000";
  const safeHost = /^[A-Za-z0-9.:[\]-]+$/.test(requestHost) ? requestHost : "localhost:3000";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https"
    ? forwardedProtocol
    : safeHost.startsWith("localhost") || safeHost.startsWith("127.") ? "http" : "https";
  return `${protocol}://${safeHost}`;
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const socialImage = new URL("/og.png", await requestOrigin()).toString();
  return (
    <html lang="th">
      <head>
        <meta property="og:image" content={socialImage} />
        <meta property="og:image:width" content="1731" />
        <meta property="og:image:height" content="909" />
        <meta property="og:image:alt" content="Pixel Brightness Windows Spatial Output Control" />
        <meta name="twitter:image" content={socialImage} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
