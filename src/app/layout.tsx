import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RailFocus - 한국 철도",
  description: "경부선 열차 추적 애플리케이션",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <link rel="stylesheet" as="style" crossOrigin="anonymous"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css" />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
