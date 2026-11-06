import UIKit
import WebKit

/// JS <-> Swift 的桥。JS 发 {id, cmd, args}，Swift 用
/// window.__pipiResolve(id, ok, payload) 回话。
final class Bridge: NSObject, WKScriptMessageHandler {

    static let name = "pipi"
    weak var webView: WKWebView?

    private let queue = DispatchQueue(label: "pipi.bridge", qos: .userInitiated)
    private var downloadTasks: [String: URLSessionDownloadTask] = [:]
    private let lock = NSLock()

    // MARK: - 收消息

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let reqId = body["id"] as? Int,
              let cmd = body["cmd"] as? String else { return }

        let args = body["args"] as? [Any] ?? []
        queue.async { [weak self] in
            self?.dispatch(reqId: reqId, cmd: cmd, args: args)
        }
    }

    private func reply(_ reqId: Int, ok: Bool, _ payload: Any) {
        var json = "null"
        if JSONSerialization.isValidJSONObject(payload),
           let data = try? JSONSerialization.data(withJSONObject: payload, options: [.fragmentsAllowed]),
           let s = String(data: data, encoding: .utf8) {
            json = s
        } else if let s = payload as? String {
            json = "\"\(s.replacingOccurrences(of: "\"", with: "\\\""))\""
        } else if let n = payload as? NSNumber {
            json = n.stringValue
        }

        let js = "window.__pipiResolve && window.__pipiResolve(\(reqId), \(ok ? "true" : "false"), \(json));"
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    private func argStr(_ args: [Any], _ i: Int) -> String {
        guard i < args.count else { return "" }
        if let s = args[i] as? String { return s }
        if let n = args[i] as? NSNumber { return n.stringValue }
        return ""
    }

    // MARK: - 分发

    private func dispatch(reqId: Int, cmd: String, args: [Any]) {
        do {
            switch cmd {
            case "sources":
                let list = SoundSource.all.map { ["id": $0.id, "label": $0.label] }
                reply(reqId, ok: true, ["items": list, "default": "vipp3"])

            case "search":
                let kw = argStr(args, 0)
                let source = argStr(args, 1)
                let limit = args.count > 2 ? (args[2] as? NSNumber)?.intValue ?? 60 : 60
                let items = try ClientPool.shared.client(source).search(kw, limit: limit)
                reply(reqId, ok: true, ["items": items.map { $0.dict }])

            case "top":
                let which = argStr(args, 0)
                let source = argStr(args, 1)
                let items = try ClientPool.shared.client(source).topList(which)
                reply(reqId, ok: true, ["items": items.map { $0.dict }])

            case "play":
                let sid = argStr(args, 0)
                let source = argStr(args, 1)
                let client = ClientPool.shared.client(source)
                let r = try client.playURL(id: sid)
                var payload = r.dict
                if r.ok {
                    let lines = try client.lyric(lkid: r.lkid, inline: r.lrc)
                    payload["lines"] = lines.map { ["t": $0.t, "text": $0.text] }
                }
                reply(reqId, ok: true, payload)

            case "lyric":
                let lkid = argStr(args, 0)
                let source = argStr(args, 1)
                let inline = argStr(args, 2)
                let lines = try ClientPool.shared.client(source).lyric(lkid: lkid, inline: inline)
                reply(reqId, ok: true, ["lines": lines.map { ["t": $0.t, "text": $0.text] }])

            case "lyricSearch":
                let title = argStr(args, 0)
                let artist = argStr(args, 1)
                let source = argStr(args, 2)
                reply(reqId, ok: true, try lyricSearch(title: title, artist: artist, source: source))

            case "resolve":
                let title = argStr(args, 0)
                let artist = argStr(args, 1)
                let source = argStr(args, 2)
                let client = ClientPool.shared.client(source)
                let kw = artist.isEmpty ? title : "\(title) \(artist)"
                let items = try client.search(kw, limit: 8)
                if let hit = pickBest(items, title: title, artist: artist) {
                    reply(reqId, ok: true, ["ok": true, "song": hit.dict])
                } else {
                    reply(reqId, ok: true, ["ok": false, "error": "本站没搜到这首歌"])
                }

            case "download":
                let sid = argStr(args, 0)
                let title = argStr(args, 1)
                let artist = argStr(args, 2)
                let source = argStr(args, 3)
                let started = try prepareDownload(sid: sid, title: title,
                                                  artist: artist, source: source)
                reply(reqId, ok: true, started)

            case "downloads":
                reply(reqId, ok: true, ["items": listDownloads()])

            case "dlStatus":
                let tid = argStr(args, 0)
                reply(reqId, ok: true, ["job": dlStatus(tid)])

            case "deleteDownload":
                let name = argStr(args, 0)
                try deleteDownload(name: name)
                reply(reqId, ok: true, ["items": listDownloads()])

            default:
                reply(reqId, ok: false, "未知命令: \(cmd)")
            }
        } catch {
            reply(reqId, ok: false, error.localizedDescription)
        }
    }

    // MARK: - 歌词借用

    private func lyricSearch(title: String, artist: String, source: String) throws -> [String: Any] {
        let client = ClientPool.shared.client(source)
        let kw = (artist.isEmpty ? title : "\(title) \(artist)")
        let items = try client.search(kw, limit: 8)
        guard let best = pickBest(items, title: title, artist: artist) else {
            return ["found": false, "lines": [] as [[String: Any]]]
        }
        let r = try client.playURL(id: best.id)
        guard r.ok else { return ["found": false, "lines": [] as [[String: Any]]] }
        let lines = try client.lyric(lkid: r.lkid, inline: r.lrc)
        return [
            "found": !lines.isEmpty,
            "lines": lines.map { ["t": $0.t, "text": $0.text] },
            "title": best.title,
            "artist": best.artist,
        ]
    }

    private func norm(_ s: String) -> String {
        var t = s.lowercased()
        t = t.replacingOccurrences(of: "[\\(（\\[【].*?[\\)）\\]】]", with: "",
                                   options: .regularExpression)
        t = t.replacingOccurrences(of: "[\\s\\-_·、,，.。'\"!！?？&+/]+", with: "",
                                   options: .regularExpression)
        return t
    }

    private func pickBest(_ items: [SongItem], title: String, artist: String) -> SongItem? {
        let nt = norm(title)
        let na = norm(artist)
        if nt.isEmpty { return nil }

        var best: SongItem?
        var bestScore = 0

        for it in items {
            let itTitle = norm(it.title)
            let itArtist = norm(it.artist)
            if itTitle.isEmpty { continue }

            var score = 0
            if itTitle == nt {
                score = 100
            } else {
                let short = itTitle.count <= nt.count ? itTitle : nt
                let long = itTitle.count <= nt.count ? nt : itTitle
                if !short.isEmpty && long.contains(short) {
                    let ratio = Double(short.count) / Double(max(long.count, 1))
                    score = ratio >= 0.5 ? 60 + Int(30 * ratio) : 10
                } else {
                    let sa = Set(nt), sb = Set(itTitle)
                    let common = Double(sa.intersection(sb).count)
                    let ratio = common / Double(max(sa.count, sb.count))
                    score = ratio >= 0.6 ? Int(40 * ratio) : 0
                }
            }
            if score <= 0 { continue }
            if !na.isEmpty && !itArtist.isEmpty {
                if itArtist == na { score += 40 }
                else if itArtist.contains(na) || na.contains(itArtist) { score += 25 }
            }
            if score > bestScore {
                bestScore = score
                best = it
            }
        }
        return bestScore >= 55 ? best : nil
    }

    // MARK: - 下载

    private var downloadsDir: URL {
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("Downloads", isDirectory: true)
        if !FileManager.default.fileExists(atPath: dir.path) {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
        return dir
    }

    private func safeName(_ raw: String) -> String {
        var s = raw.replacingOccurrences(of: "[\\\\/:*?\"<>|\\r\\n\\t]+", with: "_",
                                         options: .regularExpression)
        s = s.trimmingCharacters(in: CharacterSet(charactersIn: ". "))
        if s.count > 120 { s = String(s.prefix(120)) }
        return s.isEmpty ? "未命名" : s
    }

    /// HEAD 一下拿字节数，用来比音质
    private func remoteSize(_ urlString: String) -> Int {
        guard let u = URL(string: urlString) else { return 0 }
        var req = URLRequest(url: u)
        req.httpMethod = "HEAD"
        req.setValue(PipiClient.USER_AGENT, forHTTPHeaderField: "User-Agent")

        var size = 0
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            if let h = resp as? HTTPURLResponse {
                if h.expectedContentLength > 0 {
                    size = Int(h.expectedContentLength)
                } else if let cl = h.value(forHTTPHeaderField: "Content-Length"),
                          let n = Int(cl) {
                    size = n
                }
            }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 20)
        return size
    }

    // 下载任务状态（内存里，够前端轮询）
    private var dlJobs: [String: [String: Any]] = [:]
    private var dlOrder: [String] = []

    private func prepareDownload(sid: String, title: String,
                                 artist: String, source: String) throws -> [String: Any] {
        let client = ClientPool.shared.client(source)
        var best = try client.playURL(id: sid)
        var bestSize = best.ok ? remoteSize(best.url) : 0
        var bestSource = source

        // 33ve 的接口稳定给 320k（~10MB），同曲在别的源只有 ~1.5MB，值得多问一句
        if bestSize < 6 * 1024 * 1024, source != "33ve" {
            let c33 = ClientPool.shared.client("33ve")
            let kw = artist.isEmpty ? title : "\(title) \(artist)"
            if let items = try? c33.search(kw, limit: 6),
               let hit = pickBest(items, title: title, artist: artist),
               let r = try? c33.playURL(id: hit.id), r.ok {
                let sz = remoteSize(r.url)
                if sz > bestSize {
                    best = r
                    bestSize = sz
                    bestSource = "33ve"
                }
            }
        }

        guard best.ok else {
            return ["ok": false, "error": best.error]
        }

        var stem = artist.isEmpty ? title : "\(artist) - \(title)"
        if stem.trimmingCharacters(in: .whitespaces).isEmpty { stem = "未命名" }
        let ext = best.url.lowercased().contains(".m4a") ? ".m4a" : ".mp3"

        let tid = "\(Int(Date().timeIntervalSince1970 * 1000))"
        let saved = try beginDownload(taskId: tid, url: best.url, name: stem + ext)

        return [
            "ok": true,
            "task": tid,
            "size": bestSize,
            "source": bestSource,
            "name": saved,
            "candidates": [["source": bestSource, "size": bestSize]],
        ]
    }

    private func beginDownload(taskId: String, url: String, name: String) throws -> String {
        guard let u = URL(string: url) else { throw PipiError.message("下载地址非法") }

        var fname = safeName(name)
        if !fname.contains(".") { fname += ".mp3" }

        let dir = downloadsDir
        var dest = dir.appendingPathComponent(fname)
        var i = 1
        while FileManager.default.fileExists(atPath: dest.path) {
            let base = (fname as NSString).deletingPathExtension
            let ext = (fname as NSString).pathExtension
            dest = dir.appendingPathComponent("\(base) (\(i)).\(ext)")
            i += 1
        }

        lock.lock()
        dlJobs[taskId] = ["status": "running", "done": 0, "total": 0, "percent": 0.0,
                          "name": dest.lastPathComponent, "error": ""]
        dlOrder.insert(taskId, at: 0)
        lock.unlock()

        var req = URLRequest(url: u)
        req.setValue(PipiClient.USER_AGENT, forHTTPHeaderField: "User-Agent")
        // 不要加 Referer：酷我 CDN 带了就 403

        let task = URLSession.shared.downloadTask(with: req) { [weak self] tmp, resp, err in
            guard let self = self else { return }
            self.lock.lock()
            defer { self.lock.unlock() }

            if let err = err {
                self.dlJobs[taskId] = ["status": "error", "error": err.localizedDescription,
                                       "name": dest.lastPathComponent,
                                       "done": 0, "total": 0, "percent": 0.0]
                return
            }
            guard let tmp = tmp else {
                self.dlJobs[taskId] = ["status": "error", "error": "临时文件丢失",
                                       "name": dest.lastPathComponent,
                                       "done": 0, "total": 0, "percent": 0.0]
                return
            }
            do {
                try? FileManager.default.removeItem(at: dest)
                try FileManager.default.moveItem(at: tmp, to: dest)
                let attrs = try? FileManager.default.attributesOfItem(atPath: dest.path)
                let size = (attrs?[.size] as? NSNumber)?.intValue ?? 0
                self.dlJobs[taskId] = ["status": "done", "done": size, "total": size,
                                       "percent": 100.0, "name": dest.lastPathComponent,
                                       "error": ""]
            } catch {
                self.dlJobs[taskId] = ["status": "error", "error": "保存失败",
                                       "name": dest.lastPathComponent,
                                       "done": 0, "total": 0, "percent": 0.0]
            }
        }
        task.resume()
        return dest.lastPathComponent
    }

    private func dlStatus(_ taskId: String) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        return dlJobs[taskId] ?? ["status": "error", "error": "任务不存在"]
    }

    private func listDownloads() -> [[String: Any]] {
        let dir = downloadsDir
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey],
            options: [.skipsHiddenFiles]) else { return [] }

        var out: [[String: Any]] = []
        let audioExt: Set<String> = ["mp3", "m4a", "flac", "wav", "aac", "ogg"]

        for f in files {
            let ext = f.pathExtension.lowercased()
            if !audioExt.contains(ext) { continue }
            let values = try? f.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            let size = values?.fileSize ?? 0
            let mtime = values?.contentModificationDate?.timeIntervalSince1970 ?? 0

            let stem = (f.lastPathComponent as NSString).deletingPathExtension
            var title = stem
            var artist = ""
            if let r = stem.range(of: " - ") {
                artist = String(stem[stem.startIndex..<r.lowerBound]).trimmingCharacters(in: .whitespaces)
                title = String(stem[r.upperBound...]).trimmingCharacters(in: .whitespaces)
            }

            out.append([
                "name": f.lastPathComponent,
                "title": title,
                "artist": artist,
                "size": size,
                "mtime": mtime,
                "ext": ext,
            ])
        }
        out.sort { ($0["mtime"] as? Double ?? 0) > ($1["mtime"] as? Double ?? 0) }
        return out
    }

    private func deleteDownload(name: String) throws {
        let base = (name as NSString).lastPathComponent
        guard !base.isEmpty, base != ".", base != ".." else { return }
        let path = downloadsDir.appendingPathComponent(base)
        guard path.path.hasPrefix(downloadsDir.path) else { return }
        try? FileManager.default.removeItem(at: path)
    }

    /// 给本地播放用的 file:// 地址
    func localFileURL(name: String) -> URL? {
        let base = (name as NSString).lastPathComponent
        guard !base.isEmpty else { return nil }
        let p = downloadsDir.appendingPathComponent(base)
        guard FileManager.default.fileExists(atPath: p.path) else { return nil }
        return p
    }
}
