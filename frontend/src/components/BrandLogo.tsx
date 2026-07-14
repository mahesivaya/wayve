// The mark itself carries no text; the wordmark renders separately beside it.
//
// The PNG is a transparent, pure-black monochrome mark whose color comes from
// CSS: black on light chrome, flipped to white with `filter: invert()` on dark
// surfaces. Every instance must keep the `brand-logo` class so those rules can
// target it regardless of the per-call-site className.
//
// `gradientId` is unused, retained only so existing call sites keep compiling.
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
