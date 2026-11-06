import Foundation

/// 一个音源的接入参数
struct SoundSource {
    let id: String
    let label: String
    let base: String
    let searchPath: String     // 用 {kw} 占位
    let playPath: String
    let playType: String
    let plain: Bool            // true = 播放接口直接给明文 URL（33ve）

    static let all: [SoundSource] = [
        SoundSource(id: "vipp3", label: "皮皮音乐", base: "https://www.vipp3.com",
                    searchPath: "/so/{kw}.html", playPath: "/js/play.php",
                    playType: "music", plain: false),
        SoundSource(id: "aac", label: "AAC音乐", base: "https://www.aac.cx",
                    searchPath: "/so/{kw}.html", playPath: "/js/play.php",
                    playType: "music", plain: false),
        SoundSource(id: "33ve", label: "闪闪音乐", base: "https://www.33ve.com",
                    searchPath: "/so/{kw}.html", playPath: "/style/js/play.php",
                    playType: "dance", plain: true),
    ]

    static func find(_ id: String) -> SoundSource? {
        all.first { $0.id == id }
    }
}

enum PipiError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self {
        case .message(let m): return m
        }
    }
}

struct SongItem {
    var id: String
    var title: String
    var artist: String
    var source: String

    var dict: [String: Any] {
        ["id": id, "title": title, "artist": artist, "source": source]
    }
}

struct PlayResult {
    var ok: Bool
    var url: String
    var cover: String
    var lkid: String
    var lrc: String
    var error: String

    var dict: [String: Any] {
        ["ok": ok, "url": url, "cover": cover, "lkid": lkid, "lrc": lrc, "error": error]
    }
}

/// 每个音源一个实例，自带 cookie 会话
final class PipiClient {

    static let AES_KEY_HEX = "8a5a0271acadce264fbd5492e999a25f19abd19258fbc8252e1d9fcd69adb7bf"
    static let USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) "
        + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"

    let source: SoundSource
    private let session: URLSession
    private let sem = DispatchSemaphore(value: 1)
    private var verifiedAt: TimeInterval = 0
    private static let verifyTTL: TimeInterval = 50 * 60

    init(source: SoundSource) {
        self.source = source
        // 用 default 而不是 ephemeral：要的是 HTTPCookieStorage.shared 那套
        // 按 domain 隔离的存储。三个站域名不同，天然互不干扰，
        // 行为跟 Python 的 requests.Session 一致。
        //
        // 别写 cfg.httpCookieStorage = HTTPCookieStorage() ——
        // 那个初始化器造的是空壳，cookie 存不进去，验证拿到的 PHPSESSID
        // 会丢，之后每个请求都被判「人机验证未通过」。
        let cfg = URLSessionConfiguration.default
        cfg.httpShouldSetCookies = true
        cfg.httpCookieAcceptPolicy = .always
        cfg.urlCache = nil
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.timeoutIntervalForRequest = 25
        cfg.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: cfg)
    }

    // MARK: - 底层请求

    private func syncRequest(_ req: URLRequest) throws -> (Data, HTTPURLResponse) {
        var result: Result<(Data, HTTPURLResponse), Error>?
        let done = DispatchSemaphore(value: 0)
        let task = session.dataTask(with: req) { data, resp, err in
            if let err = err {
                result = .failure(err)
            } else if let http = resp as? HTTPURLResponse {
                result = .success((data ?? Data(), http))
            } else {
                result = .failure(PipiError.message("响应异常"))
            }
            done.signal()
        }
        task.resume()
        if done.wait(timeout: .now() + 45) == .timedOut {
            task.cancel()
            throw PipiError.message("请求超时")
        }
        switch result {
        case .success(let v): return v
        case .failure(let e): throw e
        case .none: throw PipiError.message("无响应")
        }
    }

    private func get(_ urlString: String, referer: String? = nil) throws -> (String, HTTPURLResponse) {
        guard let url = URL(string: urlString) else {
            throw PipiError.message("URL 非法: \(urlString)")
        }
        var req = URLRequest(url: url)
        req.setValue(Self.USER_AGENT, forHTTPHeaderField: "User-Agent")
        req.setValue("zh-CN,zh;q=0.9", forHTTPHeaderField: "Accept-Language")
        if let r = referer { req.setValue(r, forHTTPHeaderField: "Referer") }
        let (data, http) = try syncRequest(req)
        let text = String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .isoLatin1)
            ?? ""
        return (text, http)
    }

    private func post(_ urlString: String, form: [String: String], referer: String) throws -> String {
        guard let url = URL(string: urlString) else {
            throw PipiError.message("URL 非法")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue(Self.USER_AGENT, forHTTPHeaderField: "User-Agent")
        req.setValue(referer, forHTTPHeaderField: "Referer")
        req.setValue(source.base, forHTTPHeaderField: "Origin")
        req.setValue("XMLHttpRequest", forHTTPHeaderField: "X-Requested-With")
        req.setValue("application/x-www-form-urlencoded; charset=UTF-8",
                     forHTTPHeaderField: "Content-Type")

        var parts: [String] = []
        for (k, v) in form {
            let ek = k.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? k
            let ev = v.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? v
            parts.append("\(ek)=\(ev)")
        }
        req.httpBody = parts.joined(separator: "&").data(using: .utf8)

        let (data, _) = try syncRequest(req)
        return String(data: data, encoding: .utf8) ?? ""
    }

    // MARK: - 人机验证

    private static let csrfRe = try! NSRegularExpression(
        pattern: "name=\"csrf_token\"\\s+value=\"([^\"]+)\"", options: [])

    /// 和 Python 版一致：只认这两种标记，别用裸的 "human_check"。
    /// 首页里有可能出现这个词（脚本、注释），按裸串判会误伤。
    private static func needsVerify(_ body: String) -> Bool {
        if body.isEmpty { return true }
        return body.contains("安全人机验证") || body.contains("name=\"human_check\"")
    }

    func ensureVerified(force: Bool = false) throws {
        sem.wait()
        defer { sem.signal() }

        if !force, Date().timeIntervalSince1970 - verifiedAt < Self.verifyTTL {
            return
        }

        let (html, _) = try get(source.base + "/")
        if !Self.needsVerify(html) {
            verifiedAt = Date().timeIntervalSince1970
            return
        }

        let ns = html as NSString
        guard let m = Self.csrfRe.firstMatch(in: html, options: [],
                                             range: NSRange(location: 0, length: ns.length)) else {
            throw PipiError.message("取不到 csrf_token，站点结构可能变了")
        }
        let token = ns.substring(with: m.range(at: 1))

        var lastBody = ""
        for attempt in 1...2 {
            lastBody = try post(source.base + "/",
                                form: ["csrf_token": token, "human_check": "on"],
                                referer: source.base + "/")
            if !Self.needsVerify(lastBody) {
                verifiedAt = Date().timeIntervalSince1970
                return
            }
            // 第一次没过，稍等一下再试一遍；有些时候是会话刚建好还没生效
            if attempt == 1 {
                Thread.sleep(forTimeInterval: 0.8)
            }
        }

        let names = session.configuration.httpCookieStorage?
            .cookies?.map { $0.name }.joined(separator: ",") ?? "无"
        let brief = lastBody.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        throw PipiError.message(
            "人机验证未通过（返回 \(lastBody.count) 字节，cookie: \(names)）"
            + (brief.isEmpty ? "，页面为空" : "：\(String(brief.prefix(80)))"))
    }

    // MARK: - HTML 解析

    private static func clean(_ s: String) -> String {
        var t = s.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        let ents = ["&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"",
                    "&#39;": "'", "&apos;": "'", "&nbsp;": " "]
        for (k, v) in ents { t = t.replacingOccurrences(of: k, with: v) }
        t = t.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return t.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func firstMatch(_ pattern: String, in text: String,
                                   group: Int = 1, dotall: Bool = true) -> String? {
        var opts: NSRegularExpression.Options = [.caseInsensitive]
        if dotall { opts.insert(.dotMatchesLineSeparators) }
        guard let re = try? NSRegularExpression(pattern: pattern, options: opts) else { return nil }
        let ns = text as NSString
        guard let m = re.firstMatch(in: text, options: [],
                                    range: NSRange(location: 0, length: ns.length)),
              m.numberOfRanges > group else { return nil }
        let r = m.range(at: group)
        if r.location == NSNotFound { return nil }
        return ns.substring(with: r)
    }

    /// 把一段 <li> 解析成「歌名 + 歌手」，三种站的结构都兜住
    private static func parseBlock(_ block: String) -> (String, String)? {
        var title = ""
        var artist = ""

        // aac.cx：<span class="sname">歌名</span> + <a class="singer"><span class="sname">歌手</span>
        if let sn = firstMatch("class=\"sname\">([^<]*)</span>", in: block) {
            title = clean(sn)
            if let singerBlock = firstMatch("class=\"singer\"[^>]*>(.*?)</a>", in: block) {
                artist = clean(singerBlock)
            }
        }

        // 33ve / aac.cx：<a class="url">歌手 - 歌名</a>
        if title.isEmpty, let urlText = firstMatch("class=\"url\"[^>]*>(.*?)</a>", in: block) {
            let raw = clean(urlText)
            if let r = raw.range(of: " - ") {
                artist = String(raw[raw.startIndex..<r.lowerBound]).trimmingCharacters(in: .whitespaces)
                title = String(raw[r.upperBound...]).trimmingCharacters(in: .whitespaces)
            } else {
                title = raw
            }
        }

        // vipp3：<div class="name"><a>歌手《歌名》[MP3_LRC]</a>
        if title.isEmpty,
           let nameBlock = firstMatch("<div class=\"name\">\\s*<a[^>]*>(.*?)</a>", in: block) {
            let raw = clean(nameBlock)
            if let l = raw.range(of: "《"), let r = raw.range(of: "》") {
                artist = String(raw[raw.startIndex..<l.lowerBound]).trimmingCharacters(in: .whitespaces)
                title = String(raw[l.upperBound..<r.lowerBound]).trimmingCharacters(in: .whitespaces)
            } else {
                title = raw
            }
        }

        title = title.replacingOccurrences(of: "\\[[^\\]]*\\]$", with: "",
                                           options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return nil }
        return (title, artist)
    }

    private func parseList(_ html: String, limit: Int) -> [SongItem] {
        var items: [SongItem] = []
        var seen = Set<String>()

        let chunks = html.components(separatedBy: "<li")
        for chunk in chunks.dropFirst() {
            guard let id = Self.firstMatch("href=\"/mp3/([A-Za-z0-9]+)\\.html\"", in: chunk,
                                           dotall: false) else { continue }
            if seen.contains(id) { continue }
            guard let (title, artist) = Self.parseBlock(chunk) else { continue }
            seen.insert(id)
            items.append(SongItem(id: id, title: title, artist: artist, source: source.id))
            if items.count >= limit { break }
        }
        return items
    }

    // MARK: - 搜索

    func search(_ keyword: String, limit: Int = 60) throws -> [SongItem] {
        let kw = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        if kw.isEmpty { return [] }
        try ensureVerified()

        let encoded = kw.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? kw
        let path = source.searchPath.replacingOccurrences(of: "{kw}", with: encoded)
        let (html, _) = try get(source.base + path, referer: source.base + "/")

        if html.contains("没有找到") || html.isEmpty { return [] }

        // 只在结果区块里解析，避开底部推荐位
        var segment = html
        if let r = html.range(of: "结果列表") {
            segment = String(html[r.upperBound...])
            if let end = segment.range(of: "play_list") {
                segment = String(segment[segment.startIndex..<end.lowerBound])
            }
        }

        let items = parseList(segment, limit: limit)
        if items.isEmpty && !html.isEmpty {
            // 没解析出东西，说明页面结构和预期不一样，把线索带出去
            let hasMp3 = html.contains("/mp3/")
            let hasUrl = html.contains("class=\"url\"")
            let hasSname = html.contains("class=\"sname\"")
            let hasName = html.contains("class=\"name\"")
            throw PipiError.message(
                "没解析到结果（页面 \(html.count) 字节，"
                + "含/mp3/\(hasMp3)，class=url \(hasUrl)，"
                + "sname \(hasSname)，name \(hasName)）")
        }
        return items
    }

    // MARK: - 播放地址

    func playURL(id: String) throws -> PlayResult {
        try ensureVerified()

        let referer = "\(source.base)/mp3/\(id).html"
        let body = try post(source.base + source.playPath,
                            form: ["id": id, "type": source.playType],
                            referer: referer)

        guard let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return PlayResult(ok: false, url: "", cover: "", lkid: "", lrc: "",
                              error: "播放接口返回异常")
        }

        let msg = (json["msg"] as? NSNumber)?.intValue ?? 0
        let cover = json["pic"] as? String ?? ""
        if msg != 1 {
            let err = json["error"] as? String ?? "该歌曲无权播放 / 资源已被删除"
            return PlayResult(ok: false, url: "", cover: cover, lkid: "", lrc: "", error: err)
        }

        var url = ""
        var lrc = ""
        let lkidStr = (json["lkid"] as? NSNumber).map { $0.intValue == 0 ? "" : "\($0.intValue)" } ?? ""

        if source.plain {
            url = (json["url"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            lrc = json["lrc"] as? String ?? ""
        } else {
            if let hex = json["url"] as? String,
               let key = AESECB.dataFromHex(PipiClient.AES_KEY_HEX) {
                url = AESECB.decrypt(hex: hex, key: key) ?? ""
            }
        }
        if url.isEmpty {
            return PlayResult(ok: false, url: "", cover: cover, lkid: lkidStr, lrc: "",
                              error: "链接解析失败")
        }
        return PlayResult(ok: true, url: url, cover: cover, lkid: lkidStr, lrc: lrc, error: "")
    }

    // MARK: - 歌词

    func lyric(lkid: String, inline: String = "") throws -> [LyricLine] {
        if !inline.isEmpty { return LRCParser.parse(inline) }
        guard !lkid.isEmpty else { return [] }

        let urlStr = "https://js.eev3.com/lrc.php?cid=\(lkid)"
        guard let (body, _) = try? get(urlStr, referer: source.base + "/") else { return [] }
        guard let data = body.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return []
        }
        let lrc = json["lrc"] as? String ?? ""
        return LRCParser.parse(lrc)
    }

    // MARK: - 榜单

    func topList(_ which: String, limit: Int = 40) throws -> [SongItem] {
        try ensureVerified()
        let map = ["new": "/list/new.html", "top": "/list/top.html", "dj": "/list/djwuqu.html"]
        let path = map[which] ?? "/list/new.html"
        let (html, _) = try get(source.base + path, referer: source.base + "/")

        var segment = html
        if let r = html.range(of: "music_list") {
            segment = String(html[r.upperBound...])
        }
        return parseList(segment, limit: limit)
    }
}

/// 按 id 管理多个音源的客户端
final class ClientPool {
    static let shared = ClientPool()
    private var clients: [String: PipiClient] = [:]
    private let lock = NSLock()

    func client(_ sourceId: String) -> PipiClient {
        let id = SoundSource.find(sourceId)?.id ?? "vipp3"
        lock.lock()
        defer { lock.unlock() }
        if let c = clients[id] { return c }
        let src = SoundSource.find(id) ?? SoundSource.all[0]
        let c = PipiClient(source: src)
        clients[id] = c
        return c
    }
}
