import Foundation
import Vision
import AppKit
// usage: ocr image.png  -> lines "x y w h\ttext" (top-left origin, normalized)
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let img = NSImage(contentsOf: url), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(2) }
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.recognitionLanguages = (ProcessInfo.processInfo.environment["OCR_LANGS"] ?? "ko-KR,en-US").components(separatedBy: ",")
req.usesLanguageCorrection = false
try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
for o in req.results ?? [] {
  guard let c = o.topCandidates(1).first else { continue }
  let b = o.boundingBox
  print(String(format: "%.3f %.3f %.3f %.3f\t", b.minX, 1 - b.maxY, b.width, b.height) + c.string)
}
