import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./controls.css";

export const metadata: Metadata = {
  title: "Sensor Campus",
  description: "IoT-Sensoren überwachen und Geräte steuern",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Sensor Campus", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#123b6d",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}
