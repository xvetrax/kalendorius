import type { Metadata, Viewport } from "next";
import "./globals.css";
import "./planner-shell.css";
import {themeBootstrap} from "@/lib/ui-preferences";

export const metadata: Metadata = {
  title: "Dienos planas",
  description: "Kalendoriai, užduotys ir dienos planavimas vienoje vietoje.",
  applicationName: "Dienos planas",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Dienos planas",
  },
  formatDetection: { telephone: false },
  icons: {
    icon: "/favicon.svg",
    apple: [{ url: "/pwa/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  viewportFit: "cover",
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f7fb" },
    { media: "(prefers-color-scheme: dark)", color: "#111827" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="lt" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:themeBootstrap}}/></head><body>{children}</body></html>;
}
