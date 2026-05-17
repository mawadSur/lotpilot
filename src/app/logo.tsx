// LotPilot brand mark.
//
// Concept: a navigation chevron forming an "L" (the lot), rising toward
// an accent dot in CTA orange (the target lead). The chevron + dot
// arrangement reads as "pilot guiding a lead in" — the product's
// one-line value prop expressed as iconography. Solid trust-blue mark
// on a white-or-soft surface; on dark surfaces the mark inverts to a
// surface-light fill with the same orange accent.
//
// Sized via the `size` prop (defaults to 32px). Forwarded `className`
// allows callers to add hover transitions or focus rings.

import { type SVGProps } from "react";

interface LogoMarkProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

export function LogoMark({ size = 32, className, ...rest }: LogoMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      className={className}
      {...rest}
    >
      {/* Rounded brand tile in trust blue */}
      <rect width="32" height="32" rx="8" fill="var(--brand-primary)" />
      {/* Chevron "L" — a navigation arrow rising up-right (paper-plane heading).
          Stroke kept at 2.4 so it reads at favicon sizes. */}
      <path
        d="M9 22V11"
        stroke="white"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M9 22H20"
        stroke="white"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path
        d="M14 17L20 11"
        stroke="white"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M16.5 11H20V14.5"
        stroke="white"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Accent dot — the target lead, CTA orange */}
      <circle cx="23" cy="9" r="2" fill="var(--brand-accent)" />
    </svg>
  );
}

interface WordmarkProps {
  size?: "sm" | "md" | "lg";
  tone?: "light" | "dark";
  className?: string;
}

export function Wordmark({ size = "md", tone = "light", className }: WordmarkProps) {
  const markSize = size === "sm" ? 24 : size === "lg" ? 40 : 32;
  const textSize =
    size === "sm" ? "text-base" : size === "lg" ? "text-2xl" : "text-lg";
  const inkClass =
    tone === "dark"
      ? "text-white"
      : "text-[var(--ink-strong)]";
  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ""}`}>
      <LogoMark size={markSize} />
      <span className={`${textSize} font-bold tracking-tight ${inkClass}`}>
        LotPilot
      </span>
    </span>
  );
}
