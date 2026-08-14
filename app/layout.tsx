import type { Metadata } from "next";
import type { ReactNode } from "react";

import { getBrandCssProperties } from "@/brands/presentation";
import { getBrandRequestContext } from "@/brands/server";
import { AppShell } from "@/components/app-shell";

import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const { brand } = await getBrandRequestContext();

  return {
    applicationName: brand.displayName,
    title: {
      default: brand.displayName,
      template: `%s | ${brand.shortName}`,
    },
    description: brand.description,
  };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const { brand } = await getBrandRequestContext();

  return (
    <html
      lang="en"
      data-brand={brand.id}
      data-theme={brand.theme.id}
      style={getBrandCssProperties(brand)}
    >
      <body>
        <AppShell brand={brand}>{children}</AppShell>
      </body>
    </html>
  );
}
