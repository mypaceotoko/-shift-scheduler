import type { Metadata, Viewport } from "next";
import Shell from "@/components/v2/Shell";
import "./globals.css";
export const metadata: Metadata = {
  title: "LIBERTY | シフトスケジューラ",
  description: "CS課・PORTERの勤務希望、月間シフト生成、監査、Excel出力。",
  appleWebApp: { capable: true, title: "LIBERTY", statusBarStyle: "default" },
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#123550",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
