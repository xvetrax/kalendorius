import type { Metadata } from "next";
import "./globals.css";
import "./planner-shell.css";
import {themeBootstrap} from "@/lib/ui-preferences";

export const metadata: Metadata = {
  title: "Dienos planas",
  description: "Privatus užduočių ir Google Calendar planuoklis",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="lt" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:themeBootstrap}}/></head><body>{children}</body></html>;
}
