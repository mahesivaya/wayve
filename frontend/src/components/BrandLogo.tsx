// Fluxze brand mark. Renders the raster logo at /public/fluxze.png, sized via
// the `size` prop so every call site (header, footer, favicon-scale) stays in
// sync — change the file to change the mark everywhere. No text is baked in —
// the wordmark is rendered separately next to it.
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
      className={className}
      src="/fluxze.png"
      width={size}
      height={size}
      alt={title}
      style={{
        objectFit: "contain",
        display: "block",
        // Raster colors are baked in; nudge saturation/contrast so the light
        // teal reads more vividly. (Can't darken without graying the white bg.)
        filter: "saturate(1.4) contrast(1.1)",
      }}
    />
  );
}
