import Foundation
import CommonCrypto

/// 站点用 AES-256-ECB + PKCS7 加密播放地址，没有 IV。
enum AESECB {

    static func decrypt(hex: String, key: Data) -> String? {
        guard let data = dataFromHex(hex) else { return nil }
        return decrypt(data: data, key: key)
    }

    static func decrypt(data: Data, key: Data) -> String? {
        guard !data.isEmpty, key.count == kCCKeySizeAES256 || key.count == kCCKeySizeAES128 else {
            return nil
        }
        let outCapacity = data.count + kCCBlockSizeAES128
        var out = Data(count: outCapacity)
        var outLen = 0

        let status: CCCryptorStatus = out.withUnsafeMutableBytes { outBuf in
            data.withUnsafeBytes { inBuf in
                key.withUnsafeBytes { keyBuf in
                    CCCrypt(
                        CCOperation(kCCDecrypt),
                        CCAlgorithm(kCCAlgorithmAES),
                        CCOptions(kCCOptionPKCS7Padding | kCCOptionECBMode),
                        keyBuf.baseAddress, key.count, nil,
                        inBuf.baseAddress, data.count,
                        outBuf.baseAddress, outCapacity, &outLen
                    )
                }
            }
        }

        guard status == kCCSuccess, outLen > 0 else { return nil }
        out.removeSubrange(outLen..<out.count)
        return String(data: out, encoding: .utf8)
    }

    static func dataFromHex(_ hex: String) -> Data? {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("0x") || s.hasPrefix("0X") { s.removeFirst(2) }
        guard s.count % 2 == 0, !s.isEmpty else { return nil }
        var out = Data(capacity: s.count / 2)
        var idx = s.startIndex
        while idx < s.endIndex {
            let next = s.index(idx, offsetBy: 2)
            guard let byte = UInt8(s[idx..<next], radix: 16) else { return nil }
            out.append(byte)
            idx = next
        }
        return out
    }
}

/// LRC 解析出来的行
struct LyricLine: Codable {
    let t: Double
    let text: String
}

enum LRCParser {

    private static let timeRe = try! NSRegularExpression(
        pattern: "\\[(\\d{1,3}):(\\d{1,2})(?:[.:](\\d{1,3}))?\\]",
        options: []
    )

    private static let adRe = try! NSRegularExpression(
        pattern: "(www\\.|\\.com|\\.cn|\\.net|音乐网|免费下载|微信|公众号|QQ群)",
        options: [.caseInsensitive]
    )

    static func parse(_ lrc: String?) -> [LyricLine] {
        guard let lrc = lrc, !lrc.isEmpty else { return [] }
        var rows: [LyricLine] = []

        for raw in lrc.components(separatedBy: CharacterSet.newlines) {
            let line = raw
            let ns = line as NSString
            let matches = timeRe.matches(in: line, options: [], range: NSRange(location: 0, length: ns.length))
            if matches.isEmpty { continue }

            let text = timeRe.stringByReplacingMatches(
                in: line, options: [],
                range: NSRange(location: 0, length: ns.length),
                withTemplate: ""
            ).trimmingCharacters(in: .whitespacesAndNewlines)

            if !text.isEmpty {
                let tns = text as NSString
                let hit = adRe.firstMatch(in: text, options: [],
                                          range: NSRange(location: 0, length: tns.length))
                if hit != nil { continue }
            }

            for m in matches {
                let minStr = ns.substring(with: m.range(at: 1))
                let secStr = ns.substring(with: m.range(at: 2))
                var frac: Double = 0
                if m.range(at: 3).location != NSNotFound {
                    let f = ns.substring(with: m.range(at: 3))
                    if let v = Double(f) {
                        frac = v / pow(10, Double(f.count))
                    }
                }
                let t = (Double(minStr) ?? 0) * 60 + (Double(secStr) ?? 0) + frac
                rows.append(LyricLine(t: (t * 100).rounded() / 100, text: text))
            }
        }

        rows.sort { $0.t < $1.t }

        var out: [LyricLine] = []
        for r in rows where !r.text.isEmpty {
            if let last = out.last, abs(last.t - r.t) < 0.02, last.text == r.text { continue }
            out.append(r)
        }
        return out
    }
}
