import UIKit
import WebKit

/// JS <-> Swift 的桥。JS 发 {id, cmd, args}，Swift 用
/// window.__pipiResolve(id, ok, payload) 回话。
final class Bridge: NSObject, WKScriptMessageHandler {

    static let name = "pipi"
    weak var webView: WKWebView?

    private let queue = DispatchQueue(label: "pipi.bridge", qos: .userInitiated)
    private let mediaQueue = DispatchQueue(label: "pipi.media", qos: .userInitiated, attributes: .concurrent)
    private let lock = NSLock()
    var onAppearance: ((String) -> Void)?
    private lazy var player = NativePlayer { [weak self] event, payload in
        guard let self = self, let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        self.webView?.evaluateJavaScript("window.__pipiPlaybackEvent && window.__pipiPlaybackEvent('\(event)', \(json));",
                                         completionHandler: nil)
    }
    static var nowPlayingIconURL: URL? {
        Bundle.main.url(forResource: "AppIcon60x60@3x", withExtension: "png")
            ?? Bundle.main.url(forResource: "AppIcon60x60@3x", withExtension: "png", subdirectory: "Web")
    }

    // MARK: - 收消息

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let reqId = body["id"] as? Int,
              let cmd = body["cmd"] as? String else { return }

        let args = body["args"] as? [Any] ?? []
        if cmd.hasPrefix("audio") || cmd == "appearance" {
            DispatchQueue.main.async { [weak self] in self?.handlePlayer(reqId, cmd, args) }
            return
        }
        let target = ["play", "cover", "lyric", "lyricSearch", "download", "dlStatus"].contains(cmd) ? mediaQueue : queue
        target.async { [weak self] in
            self?.dispatch(reqId: reqId, cmd: cmd, args: args)
        }
    }

    private func handlePlayer(_ reqId: Int, _ cmd: String, _ args: [Any]) {
        let value = args.first as? NSNumber
        switch cmd {
        case "appearance":
            let mode = args.first as? String ?? "system"
            if ["system", "light", "dark"].contains(mode) { onAppearance?(mode) }
        case "audioLoad":
            let item = args.first as? [String: Any] ?? [:]
            let local = item["local"] as? String ?? ""
            let url = local.isEmpty ? URL(string: item["url"] as? String ?? "") : localFileURL(name: local)
            guard let url = url, (!local.isEmpty || ["http", "https"].contains(url.scheme ?? "")),
                  let token = item["token"] as? Int else {
                reply(reqId, ok: false, "音频地址无效或文件已删除")
                return
            }
            let workers = min(16, max(1, item["workers"] as? Int ?? 3))
            player.load(url, token: token, title: item["title"] as? String ?? "",
                        artist: item["artist"] as? String ?? "", workers: workers)
        case "audioPlay": player.play()
        case "audioPause": player.pause()
        case "audioSeek": player.seek(value?.doubleValue ?? 0)
        case "audioLoop": player.setLoop(value?.boolValue ?? false)
        case "audioVolume": player.setVolume(value?.floatValue ?? 1)
        default: break
        }
        reply(reqId, ok: true, ["ok": true])
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
                let ordered = SoundSource.all.filter { $0.id == "33ve" } + SoundSource.all.filter { $0.id != "33ve" }
                let list = ordered.map { ["id": $0.id, "label": $0.label] }
                reply(reqId, ok: true, ["items": list, "default": "33ve"])

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
                let audio = try resolvePlayback(sid: sid, title: argStr(args, 2),
                                                artist: argStr(args, 3), source: source, workers: 3)
                var payload = audio.result.dict
                payload["source"] = audio.source
                reply(reqId, ok: true, payload)

            case "cover":
                let result = try ClientPool.shared.client(argStr(args, 1)).playURL(id: argStr(args, 0))
                reply(reqId, ok: true, ["cover": result.cover])

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
                let workers = workerCount(args, index: 4, fallback: 4, maximum: 16)
                let started = try prepareDownload(sid: sid, title: title,
                                                  artist: artist, source: source, workers: workers)
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

    private func workerCount(_ args: [Any], index: Int, fallback: Int, maximum: Int) -> Int {
        guard args.indices.contains(index), let n = args[index] as? NSNumber else { return fallback }
        return min(maximum, max(1, n.intValue))
    }

    private func resolveAudio(sid: String, title: String, artist: String,
                              source: String, candidate: String) throws -> PlayResult {
        let client = ClientPool.shared.client(candidate)
        if candidate == source, !sid.isEmpty { return try client.playURL(id: sid) }
        let titleKey = title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let artistKey = artist.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !titleKey.isEmpty, !artistKey.isEmpty else {
            throw PipiError.message("缺少歌名或歌手，无法匹配音源")
        }
        let songs = try client.search("\(title) \(artist)", limit: 8)
        guard let match = songs.first(where: {
            $0.title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == titleKey &&
            $0.artist.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == artistKey
        }) else { throw PipiError.message("该音源没有找到同一首歌") }
        return try client.playURL(id: match.id)
    }

    private func resolvePlayback(sid: String, title: String, artist: String, source: String,
                                 workers: Int) throws -> (result: PlayResult, source: String) {
        let source = SoundSource.find(source)?.id ?? "vipp3"
        let candidates = ["33ve"] + (source == "33ve" ? [] : [source])
            + SoundSource.all.map(\.id).filter { $0 != "33ve" && $0 != source }
        if workers == 1 {
            for candidate in candidates {
                if let result = try? resolveAudio(sid: sid, title: title, artist: artist,
                                                  source: source, candidate: candidate), result.ok {
                    return (result, candidate)
                }
            }
            throw PipiError.message("没有找到可播放的音源")
        }

        let tasks = OperationQueue()
        tasks.maxConcurrentOperationCount = workers
        tasks.qualityOfService = .userInitiated
        let condition = NSCondition()
        var remaining = candidates.count
        var preferredPending = true
        var preferred: PlayResult?
        var fallback: (result: PlayResult, source: String)?
        var graceDeadline: Date?
        let timeout = Date().addingTimeInterval(70)
        let operations = candidates.map { candidate -> BlockOperation in
            let operation = BlockOperation {
                let result = try? self.resolveAudio(sid: sid, title: title, artist: artist,
                                                    source: source, candidate: candidate)
                condition.lock()
                if candidate == "33ve" {
                    preferredPending = false
                    if let result = result, result.ok { preferred = result }
                } else if let result = result, result.ok, fallback == nil {
                    fallback = (result, candidate)
                    graceDeadline = Date().addingTimeInterval(0.35)
                }
                remaining -= 1
                condition.signal()
                condition.unlock()
            }
            operation.queuePriority = candidate == "33ve" ? .veryHigh : candidate == source ? .high : .normal
            return operation
        }
        tasks.addOperations(operations, waitUntilFinished: false)
        defer { tasks.cancelAllOperations() }
        condition.lock()
        defer { condition.unlock() }
        while preferred == nil, remaining > 0, fallback == nil || preferredPending {
            let deadline = min(timeout, graceDeadline ?? timeout)
            if !condition.wait(until: deadline) { break }
        }
        if let preferred = preferred { return (preferred, "33ve") }
        if let fallback = fallback { return fallback }
        throw PipiError.message("没有找到可播放的音源")
    }

    private var dlJobs: [String: [String: Any]] = [:]

    private func prepareDownload(sid: String, title: String, artist: String,
                                 source: String, workers: Int) throws -> [String: Any] {
        let audio: PlayResult
        do {
            audio = try resolveAudio(sid: sid, title: title, artist: artist,
                                     source: source, candidate: "33ve")
        } catch {
            throw PipiError.message("33ve 下载失败：\(error.localizedDescription)")
        }
        guard audio.ok else { return ["ok": false, "error": "33ve 下载失败：\(audio.error)"] }

        let stem = artist.isEmpty ? title : "\(artist) - \(title)"
        let pathExt = URL(string: audio.url)?.pathExtension.lowercased() ?? ""
        let ext = ["mp3", "m4a", "flac", "wav", "aac", "ogg"].contains(pathExt) ? pathExt : "mp3"
        let taskId = UUID().uuidString
        let saved = try beginDownload(taskId: taskId, url: audio.url,
                                      name: safeName(stem) + "." + ext, workers: workers)
        return ["ok": true, "task": taskId, "source": "33ve", "name": saved]
    }

    private func beginDownload(taskId: String, url: String, name: String, workers: Int) throws -> String {
        guard let url = URL(string: url), ["http", "https"].contains(url.scheme ?? "") else {
            throw PipiError.message("下载地址非法")
        }

        let dir = downloadsDir
        lock.lock()
        let reserved = Set(dlJobs.values.compactMap { job -> String? in
            guard job["status"] as? String == "running" else { return nil }
            return job["name"] as? String
        })
        var file = dir.appendingPathComponent(name)
        var i = 1
        while reserved.contains(file.lastPathComponent) || FileManager.default.fileExists(atPath: file.path) {
            let base = (name as NSString).deletingPathExtension
            let ext = (name as NSString).pathExtension
            file = dir.appendingPathComponent("\(base) (\(i)).\(ext)")
            i += 1
        }
        let dest = file
        dlJobs[taskId] = ["status": "running", "done": 0, "total": 0, "percent": 0.0,
                          "name": dest.lastPathComponent, "error": ""]
        lock.unlock()

        var request = URLRequest(url: url, timeoutInterval: 20)
        request.setValue(PipiClient.USER_AGENT, forHTTPHeaderField: "User-Agent")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        ParallelDownload.start(request, workers: workers, progress: { [weak self] done, total in
            guard let self = self else { return }
            self.lock.lock()
            defer { self.lock.unlock() }
            self.dlJobs[taskId]?["done"] = done
            self.dlJobs[taskId]?["total"] = total
            self.dlJobs[taskId]?["percent"] = total > 0 ? Double(done) / Double(total) * 100 : 0
        }, completion: { [weak self] result in
            guard let self = self else { return }
            self.lock.lock()
            defer { self.lock.unlock() }
            do {
                let tmp = try result.get()
                let size = try tmp.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size > 0 else { throw PipiError.message("下载文件为空") }
                try FileManager.default.moveItem(at: tmp, to: dest)
                self.dlJobs[taskId] = ["status": "done", "done": size, "total": size,
                                       "percent": 100.0, "name": dest.lastPathComponent, "error": ""]
            } catch {
                self.dlJobs[taskId] = ["status": "error", "error": error.localizedDescription,
                                       "name": dest.lastPathComponent, "done": 0, "total": 0, "percent": 0.0]
            }
        })
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
