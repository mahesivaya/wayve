// Fluxze brand mark. Renders the raster logo at /public/brand/fluxze.png, sized via
// the `size` prop so every call site (header, footer, favicon-scale) stays in
// sync — change the file to change the mark everywhere. No text is baked in —
// the wordmark is rendered separately next to it.
//
// The PNG is a transparent-background, pure-black monochrome mark, so its color
// is driven by CSS: it shows black on light chrome and is flipped to white via
// `filter: invert()` on dark surfaces (see the `.brand-logo` rules in
// Layout.css / marketing.css). Every instance carries the `brand-logo` class so
// those rules can target it regardless of the per-call-site className.
//
// `gradientId` is accepted but unused now (kept so existing call sites that
// pass it keep compiling); it mattered only for the previous inline SVG.
type BrandLogoProps = {
  size?: number;
  className?: string;
  gradientId?: string;
  title?: string;
};

export default function BrandLogo({
  size = 28,
  className,
  title = "Fluxze",
}: BrandLogoProps) {
  return (
    <img
      className={["brand-logo", className].filter(Boolean).join(" ")}
      src="/brand/fluxze.png"
      width={size}
      height={size}
      alt={title}
      style={{
        objectFit: "contain",
        display: "block",
      }}
    />
  );
}
