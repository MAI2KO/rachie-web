"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navigationItems = [
  { href: "/", label: "Home" },
  { href: "/booking", label: "Booking" },
  { href: "/world", label: "World Map" },
  { href: "/events", label: "Events" },
  { href: "/help", label: "Help" },
] as const;

export function SiteNavigation() {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary navigation" className="site-nav">
      <ul className="site-nav__list">
        {navigationItems.map((item) => (
          <li key={item.href}>
            <Link
              aria-current={pathname === item.href ? "page" : undefined}
              className="site-nav__link"
              href={item.href}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
