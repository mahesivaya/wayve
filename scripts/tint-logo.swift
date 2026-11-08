// Recolours a logo: every pixel becomes <hex colour>, keeping the original
// alpha. Used by make-icons.sh to make the light-on-dark desktop icon from the
// one black brand logo (sips can't recolour).
//
//   swift scripts/tint-logo.swift <in.png> <out.png> <RRGGBB>

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count == 4,
      let hex = UInt32(args[3], radix: 16),
      let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: args[1]) as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
    FileHandle.standardError.write("usage: tint-logo.swift <in.png> <out.png> <RRGGBB>\n".data(using: .utf8)!)
    exit(1)
}

let width = image.width
let height = image.height
guard let context = CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else { exit(1) }

let rect = CGRect(x: 0, y: 0, width: width, height: height)
context.draw(image, in: rect)
// sourceIn keeps the logo's alpha and replaces its colour with the fill.
context.setBlendMode(.sourceIn)
context.setFillColor(
    red: CGFloat((hex >> 16) & 0xFF) / 255,
    green: CGFloat((hex >> 8) & 0xFF) / 255,
    blue: CGFloat(hex & 0xFF) / 255,
    alpha: 1
)
context.fill(rect)

guard let tinted = context.makeImage(),
      let dest = CGImageDestinationCreateWithURL(
          URL(fileURLWithPath: args[2]) as CFURL, UTType.png.identifier as CFString, 1, nil)
else { exit(1) }
CGImageDestinationAddImage(dest, tinted, nil)
exit(CGImageDestinationFinalize(dest) ? 0 : 1)
