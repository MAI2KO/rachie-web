import Link from "next/link";
import type { ReactNode } from "react";

import type { ActiveBrand } from "@/brands/config";

import { BrandVisualLayer } from "./brand-visual-layer";
import { SiteNavigation } from "./site-navigation";

interface AppShellProps {
  readonly brand: ActiveBrand;
  readonly children: ReactNode;
}

export function AppShell({ brand, children }: AppShellProps) {
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <BrandVisualLayer brand={brand} />
      <header className="site-header">
        <div className="shell-width site-header__inner">
          <Link
            aria-label={`${brand.displayName} home`}
            className="brand-lockup"
            href="/"
          >
            <span className="brand-lockup__name">{brand.displayName}</span>
            <span className="brand-lockup__game">{brand.game.name}</span>
          </Link>
          <SiteNavigation />
        </div>
      </header>
      <main className="shell-width site-main" id="main-content" tabIndex={-1}>
        {children}
      </main>
      <footer className="site-footer">
        <div className="shell-width site-footer__inner">
          <span>{brand.shortName}</span>
          <span aria-hidden="true">/</span>
          <span>{brand.game.name}</span>
        </div>
      </footer>
    </>
  );
}
