import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import SaveToast from "@/components/SaveToast";

export const metadata: Metadata = {
  title: "シフトスケジューラ",
  description: "店舗向けシフト作成支援Webアプリ",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="flex-1 p-6 lg:p-8 overflow-x-auto">{children}</main>
        </div>
        <SaveToast />
      </body>
    </html>
  );
}
