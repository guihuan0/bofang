import Foundation

enum LosslessDownload {
    static func resolve(source: SoundSource, id: String, password: String) -> URL? {
        guard source.id == "vipp3" || source.id == "aac", !id.isEmpty,
              var parts = URLComponents(string: source.base + "/plug/down.php") else { return nil }
        parts.queryItems = [
            URLQueryItem(name: "ac", value: "music"),
            URLQueryItem(name: "id", value: id),
            URLQueryItem(name: "k", value: "flac"),
        ]
        guard let endpoint = parts.url else { return nil }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForResource = 10
        let session = URLSession(configuration: config)
        defer { session.finishTasksAndInvalidate() }
        if !password.isEmpty {
            guard let login = URL(string: source.base + "/plug/login.php") else { return nil }
            var request = URLRequest(url: login, timeoutInterval: 5)
            request.httpMethod = "POST"
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            request.setValue(source.base + "/down.php?ac=music&id=" + id, forHTTPHeaderField: "Referer")
            var form = URLComponents()
            form.queryItems = [URLQueryItem(name: "lkpwd", value: password)]
            request.httpBody = form.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B").data(using: .utf8)
            guard let (data, _) = fetch(request, session: session),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (json["code"] as? NSNumber)?.intValue == 1 else { return nil }
        }
        var request = URLRequest(url: endpoint, timeoutInterval: 5)
        request.setValue("bytes=0-15", forHTTPHeaderField: "Range")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        request.setValue(PipiClient.USER_AGENT, forHTTPHeaderField: "User-Agent")
        guard let (data, response) = fetch(request, session: session),
              [200, 206].contains(response.statusCode),
              data.starts(with: [0x66, 0x4c, 0x61, 0x43]),
              let url = response.url, url.scheme == "https",
              let host = url.host, host == "kuwo.cn" || host.hasSuffix(".kuwo.cn") else { return nil }
        return url
    }

    private static func fetch(_ request: URLRequest, session: URLSession) -> (Data, HTTPURLResponse)? {
        let done = DispatchSemaphore(value: 0)
        var result: (Data, HTTPURLResponse)?
        let task = session.dataTask(with: request) { data, response, _ in
            if let data = data, let response = response as? HTTPURLResponse {
                result = (data, response)
            }
            done.signal()
        }
        task.resume()
        guard done.wait(timeout: .now() + 10) == .success else { task.cancel(); return nil }
        return result
    }
}
