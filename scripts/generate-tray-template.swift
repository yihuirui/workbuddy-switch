#!/usr/bin/swift
// Generate the simple, single-color cat mark used by the macOS menu bar and
// by the Windows light/dark tray variants. Run from any directory:
//   swift scripts/generate-tray-template.swift [output.png]
import AppKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let destination = CommandLine.arguments.dropFirst().first
    ?? "src-tauri/icons/tray-icon-template.png"
let size = 144 // 4× the 36 px macOS template; gen-tray-icon.py downsamples it.
let colorSpace = CGColorSpaceCreateDeviceRGB()
let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue)
guard let context = CGContext(
    data: nil,
    width: size,
    height: size,
    bitsPerComponent: 8,
    bytesPerRow: size * 4,
    space: colorSpace,
    bitmapInfo: bitmapInfo.rawValue
) else { fatalError("Unable to create the tray icon canvas") }

context.setAllowsAntialiasing(true)
context.setShouldAntialias(true)
context.setFillColor(NSColor.white.cgColor)

// A compact cat-head silhouette echoes the app mascot without carrying the
// detailed full-color artwork into a 18 pt menu bar glyph.
let head = CGMutablePath()
head.move(to: CGPoint(x: 23, y: 112))
head.addCurve(to: CGPoint(x: 43, y: 124), control1: CGPoint(x: 14, y: 120), control2: CGPoint(x: 22, y: 129))
head.addLine(to: CGPoint(x: 17, y: 138))
head.addCurve(to: CGPoint(x: 59, y: 126), control1: CGPoint(x: 26, y: 143), control2: CGPoint(x: 42, y: 137))
head.addCurve(to: CGPoint(x: 85, y: 126), control1: CGPoint(x: 67, y: 130), control2: CGPoint(x: 76, y: 130))
head.addCurve(to: CGPoint(x: 127, y: 138), control1: CGPoint(x: 102, y: 137), control2: CGPoint(x: 118, y: 143))
head.addLine(to: CGPoint(x: 101, y: 124))
head.addCurve(to: CGPoint(x: 121, y: 112), control1: CGPoint(x: 122, y: 128), control2: CGPoint(x: 130, y: 120))
head.addCurve(to: CGPoint(x: 127, y: 78), control1: CGPoint(x: 131, y: 101), control2: CGPoint(x: 131, y: 88))
head.addCurve(to: CGPoint(x: 104, y: 45), control1: CGPoint(x: 124, y: 63), control2: CGPoint(x: 116, y: 52))
head.addCurve(to: CGPoint(x: 72, y: 36), control1: CGPoint(x: 93, y: 38), control2: CGPoint(x: 83, y: 36))
head.addCurve(to: CGPoint(x: 40, y: 45), control1: CGPoint(x: 61, y: 36), control2: CGPoint(x: 51, y: 38))
head.addCurve(to: CGPoint(x: 17, y: 78), control1: CGPoint(x: 28, y: 52), control2: CGPoint(x: 20, y: 63))
head.addCurve(to: CGPoint(x: 23, y: 112), control1: CGPoint(x: 13, y: 88), control2: CGPoint(x: 13, y: 101))
head.closeSubpath()
context.addPath(head)
context.fillPath()

// Face details are transparent cut-outs. The eye and nose shapes stay large
// enough to survive downsampling to 36×36 without creating stray dark pixels.
context.setBlendMode(.clear)
for x in [45.0, 88.0] {
    context.fillEllipse(in: CGRect(x: x, y: 78, width: 11, height: 15))
}
let nose = CGMutablePath()
nose.move(to: CGPoint(x: 67, y: 69))
nose.addQuadCurve(to: CGPoint(x: 77, y: 69), control: CGPoint(x: 72, y: 64))
nose.addQuadCurve(to: CGPoint(x: 72, y: 61), control: CGPoint(x: 78, y: 60))
nose.addQuadCurve(to: CGPoint(x: 67, y: 69), control: CGPoint(x: 66, y: 60))
nose.closeSubpath()
context.addPath(nose)
context.fillPath()

guard let image = context.makeImage() else { fatalError("Unable to render the tray icon") }
let url = URL(fileURLWithPath: destination)
try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fatalError("Unable to create \(url.path)")
}
CGImageDestinationAddImage(destination, image, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("Unable to write \(url.path)") }
print("Generated \(url.path) (\(size)×\(size) RGBA template source)")
