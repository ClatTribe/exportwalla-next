// Reads text from an image or PDF with macOS Vision (on-device, no network, no API key).
// Usage: ocr <file>   -> prints text. PDFs with a text layer are read directly; scanned pages are OCR'd.
import Foundation
import Vision
import PDFKit
import AppKit

// Flatten onto white (transparent PNGs read as black) and upscale small images.
func flatten(_ src: CGImage) -> CGImage {
    let scale = src.width < 1000 ? 3 : (src.width < 2000 ? 2 : 1)
    let w = src.width * scale, h = src.height * scale
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return src }
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.interpolationQuality = .high
    ctx.draw(src, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage() ?? src
}

func recognize(_ raw: CGImage) -> String {
    let cg = flatten(raw)
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = true
    req.recognitionLanguages = ["en-US"]
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    try? handler.perform([req])
    let obs = (req.results ?? []).sorted {
        // top-to-bottom, then left-to-right, so table rows stay on one line
        abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.004 ? $0.boundingBox.midY > $1.boundingBox.midY
                                                              : $0.boundingBox.minX < $1.boundingBox.minX
    }
    var lines: [String] = []
    var lastY: CGFloat = -1
    for o in obs {
        guard let s = o.topCandidates(1).first?.string else { continue }
        if lastY >= 0 && abs(o.boundingBox.midY - lastY) <= 0.004, let prev = lines.popLast() {
            lines.append(prev + "  " + s)
        } else {
            lines.append(s)
        }
        lastY = o.boundingBox.midY
    }
    return lines.joined(separator: "\n")
}

let args = CommandLine.arguments
guard args.count > 1 else { FileHandle.standardError.write("usage: ocr <file>\n".data(using: .utf8)!); exit(2) }
let url = URL(fileURLWithPath: args[1])
let maxPages = args.count > 2 ? (Int(args[2]) ?? 20) : 20
let forceOCR = args.count > 3 && args[3] == "ocr"      // ignore the text layer: read the page as an image
var out = ""
if url.pathExtension.lowercased() == "pdf", let doc = PDFDocument(url: url) {
    for i in 0..<min(doc.pageCount, maxPages) {
        guard let page = doc.page(at: i) else { continue }
        let text = page.string ?? ""
        if !forceOCR && text.trimmingCharacters(in: .whitespacesAndNewlines).count > 40 {
            out += text + "\n\u{0C}\n"
        } else {
            let bounds = page.bounds(for: .mediaBox)
            let scale: CGFloat = 2.5
            let img = page.thumbnail(of: NSSize(width: bounds.width * scale, height: bounds.height * scale), for: .mediaBox)
            if let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) { out += recognize(cg) + "\n" }
        }
    }
} else if let img = NSImage(contentsOf: url), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
    out = recognize(cg)
} else {
    FileHandle.standardError.write("cannot read \(url.path)\n".data(using: .utf8)!); exit(1)
}
print(out)
