import UIKit
import WebKit

/// 让 WebView 用 pipilocal:// 读下载目录里的音频。
/// 直接给 file:// 的话 WKWebView 不放行，音频播不出来。
final class LocalAudioScheme: NSObject, WKURLSchemeHandler {

    static let scheme = "pipilocal"

    private var downloadsDir: URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Downloads", isDirectory: true)
    }

    private func mime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "mp3": return "audio/mpeg"
        case "m4a": return "audio/mp4"
        case "flac": return "audio/flac"
        case "wav": return "audio/wav"
        case "aac": return "audio/aac"
        case "ogg": return "audio/ogg"
        default: return "application/octet-stream"
        }
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else {
            task.didFailWithError(PipiError.message("bad url"))
            return
        }

        // pipilocal://local/<文件名>
        let raw: String = url.path.isEmpty ? (url.host ?? "") : url.path
        let name = (raw as NSString).lastPathComponent
        if name.isEmpty {
            task.didFailWithError(PipiError.message("empty name"))
            return
        }

        let audio = downloadsDir.appendingPathComponent(name)
        let isCover = url.host == "cover"
        let file = isCover ? audio.appendingPathExtension("cover.jpg") : audio
        guard file.path.hasPrefix(downloadsDir.path),
              FileManager.default.fileExists(atPath: file.path) else {
            task.didFailWithError(PipiError.message("not found"))
            return
        }

        guard let size = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size > 0 else {
            task.didFailWithError(PipiError.message("read failed"))
            return
        }

        var start = 0
        var end = size - 1
        var status = 200
        var headers = ["Content-Type": isCover ? "image/jpeg" : mime(file.pathExtension), "Accept-Ranges": "bytes",
                       "Access-Control-Allow-Origin": "*"]
        if let range = task.request.value(forHTTPHeaderField: "Range"),
           range.hasPrefix("bytes="), !range.contains(",") {
            let bounds = range.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
            var valid = false
            if bounds.count == 2 {
                if let first = Int(bounds[0]), first >= 0, first < size {
                    if bounds[1].isEmpty {
                        start = first
                        valid = true
                    } else if let last = Int(bounds[1]), last >= first {
                        start = first
                        end = min(last, end)
                        valid = true
                    }
                } else if bounds[0].isEmpty, let suffix = Int(bounds[1]), suffix > 0 {
                    start = size - min(size, suffix)
                    valid = true
                }
            }
            if !valid {
                if let response = HTTPURLResponse(url: url, statusCode: 416, httpVersion: "HTTP/1.1",
                                                  headerFields: ["Content-Range": "bytes */\(size)"]) {
                    task.didReceive(response)
                    task.didFinish()
                } else {
                    task.didFailWithError(PipiError.message("invalid audio range"))
                }
                return
            }
            status = 206
            headers["Content-Range"] = "bytes \(start)-\(end)/\(size)"
        }
        let length = end - start + 1
        headers["Content-Length"] = String(length)
        let data: Data
        do {
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(start))
            guard let chunk = try handle.read(upToCount: length), chunk.count == length else {
                throw PipiError.message("incomplete audio file")
            }
            data = chunk
        } catch {
            task.didFailWithError(error)
            return
        }

        let resp = HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )
        guard let resp = resp else {
            task.didFailWithError(PipiError.message("no response"))
            return
        }
        task.didReceive(resp)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        // 一次性读文件，没有需要收尾的
    }
}
