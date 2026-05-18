// LotPilot Open Graph image (v0.8.2).
//
// Generated dynamically at the edge by Next.js's built-in OG support.
// One file, no PNG asset to maintain — Next caches the result.
//
// 1200×630 is the canonical Twitter/Facebook/Slack/iMessage OG size.
// All copy + colors come from the live design tokens so the OG image
// stays in lock-step with the landing if the brand evolves.
//
// Visual: hero headline on the left, a stylised version of the
// LotPilot brand chevron on the right, sitting on the trust-blue +
// orange-CTA palette established in globals.css.

import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "LotPilot — Bilingual AI sales assistant for independent used-car dealers";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Brand tokens — must mirror src/app/globals.css. We inline rather
// than import the CSS variables because the edge runtime serialises
// styles to PNG via Satori and can't resolve `var(--...)`.
const BRAND_PRIMARY = "#2563eb";
const BRAND_ACCENT = "#ea580c";
const SURFACE_BASE = "#ffffff";
const INK_STRONG = "#0f172a";
const INK_MUTED = "#475569";
const LINE_SOFT = "#e2e8f0";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "row",
          backgroundColor: SURFACE_BASE,
          padding: "72px",
          fontFamily: "sans-serif",
        }}
      >
        {/* Left column: brand + headline + sub */}
        <div
          style={{
            flex: "1 1 0",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <BrandTile />
            <span
              style={{
                fontSize: 36,
                fontWeight: 700,
                letterSpacing: -1,
                color: INK_STRONG,
              }}
            >
              LotPilot
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "6px 14px",
                borderRadius: 999,
                backgroundColor: "#dbeafe",
                color: "#1d4ed8",
                fontSize: 18,
                fontWeight: 700,
                letterSpacing: 1.5,
                textTransform: "uppercase",
                width: "fit-content",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  backgroundColor: BRAND_PRIMARY,
                  display: "block",
                }}
              />
              For independent used-car dealers
            </div>
            <h1
              style={{
                fontSize: 80,
                fontWeight: 800,
                lineHeight: 1.05,
                letterSpacing: -2.5,
                color: INK_STRONG,
                margin: 0,
                display: "flex",
                flexDirection: "column",
              }}
            >
              <span>Every Marketplace lead,</span>
              <span>
                answered in{" "}
                <span style={{ color: BRAND_PRIMARY }}>60 seconds.</span>
              </span>
            </h1>
            <p
              style={{
                fontSize: 28,
                color: INK_MUTED,
                lineHeight: 1.35,
                fontWeight: 500,
                margin: 0,
                maxWidth: 760,
              }}
            >
              Bilingual AI sales assistant. EN/ES. TCPA-compliant. Built by a
              10-year used-car salesperson.
            </p>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              fontSize: 20,
              color: INK_MUTED,
              fontWeight: 500,
            }}
          >
            <span style={{ display: "flex" }}>Marketplace</span>
            <Dot />
            <span style={{ display: "flex" }}>SMS</span>
            <Dot />
            <span style={{ display: "flex" }}>WhatsApp</span>
            <Dot />
            <span style={{ display: "flex" }}>Calendly</span>
          </div>
        </div>

        {/* Right column: chat-bubble proof */}
        <div
          style={{
            width: 420,
            marginLeft: 56,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 14,
          }}
        >
          <Bubble side="left" text="¿Sigue disponible el Civic 2019 LX?" />
          <Bubble
            side="right"
            text="¡Sí! 52k millas, un solo dueño. ¿Pasas mañana después de las 4?"
            tag="AI · 47 sec"
          />
          <Bubble side="left" text="Perfecto, mañana a las 5." />
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              padding: "14px 18px",
              borderRadius: 14,
              border: "2px solid #a7f3d0",
              backgroundColor: "#ecfdf5",
              color: "#065f46",
            }}
          >
            <span style={{ fontSize: 18, fontWeight: 700, display: "flex" }}>
              Test drive booked
            </span>
            <span style={{ fontSize: 14, color: "#047857", display: "flex" }}>
              Lead status → booked · auto-confirm scheduled
            </span>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}

function BrandTile() {
  // Inline approximation of the LogoMark component, sized for OG.
  return (
    <div
      style={{
        width: 56,
        height: 56,
        borderRadius: 14,
        backgroundColor: BRAND_PRIMARY,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
      }}
    >
      {/* Chevron arrow rendered as positioned blocks because Satori has
          limited SVG support. Three rectangles forming an L + arrow. */}
      <div
        style={{
          position: "absolute",
          left: 14,
          top: 16,
          width: 4,
          height: 24,
          backgroundColor: "white",
          borderRadius: 2,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 14,
          bottom: 14,
          width: 22,
          height: 4,
          backgroundColor: "white",
          borderRadius: 2,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: 10,
          top: 10,
          width: 10,
          height: 10,
          borderRadius: 999,
          backgroundColor: BRAND_ACCENT,
        }}
      />
    </div>
  );
}

function Dot() {
  return (
    <span
      style={{
        width: 4,
        height: 4,
        borderRadius: 999,
        backgroundColor: LINE_SOFT,
        display: "block",
      }}
    />
  );
}

function Bubble({
  side,
  text,
  tag,
}: {
  side: "left" | "right";
  text: string;
  tag?: string;
}) {
  const isRight = side === "right";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: isRight ? "flex-end" : "flex-start",
      }}
    >
      <div
        style={{
          maxWidth: 360,
          padding: "12px 16px",
          borderRadius: 18,
          borderBottomLeftRadius: isRight ? 18 : 6,
          borderBottomRightRadius: isRight ? 6 : 18,
          fontSize: 18,
          lineHeight: 1.3,
          backgroundColor: isRight ? BRAND_PRIMARY : "#f1f5f9",
          color: isRight ? "white" : INK_STRONG,
          display: "flex",
        }}
      >
        {text}
      </div>
      {tag ? (
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            color: "#cbd5e1",
            marginTop: 4,
            display: "flex",
          }}
        >
          {tag}
        </span>
      ) : null}
    </div>
  );
}
