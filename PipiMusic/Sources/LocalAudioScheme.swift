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
        let raw = url.path.isEmpty ? url.host : url.path
        let name = (raw as NSString).lastPathComponent
        if name.isEmpty {
            task.didFailWithError(PipiError.message("empty name"))
            return
        }

        let file = downloadsDir.appendingPathComponent(name)
        guard file.path.hasPrefix(downloadsDir.path),
              FileManager.default.fileExists(atPath: file.path) else {
            task.didFailWithError(PipiError.message("not found"))
            return
        }

        guard let data = try? Data(contentsOf: file) else {
            task.didFailWithError(PipiError.message("read failed"))
            return
        }

        let mimeType = mime(file.pathExtension)
        let resp = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": mimeType,
                "Content-Length": "\(data.count)",
                "Accept-Ranges": "bytes",
                "Access-Control-Allow-Origin": "*",
            ]
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
