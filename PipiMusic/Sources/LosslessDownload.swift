import Foundation

enum LosslessDownload {
    private final class Redirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            guard let url = request.url, url.scheme == "https", let host = url.host,
                  host == "kuwo.cn" || host.hasSuffix(".kuwo.cn") else {
                completionHandler(nil)
                return
            }
            var clean = URLRequest(url: url, timeoutInterval: 5)
            clean.setValue("bytes=0-15", forHTTPHeaderField: "Range")
            clean.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
            clean.setValue(PipiClient.USER_AGENT, forHTTPHeaderField: "User-Agent")
            completionHandler(clean)
        }
    }

    static func resolve(source: SoundSource, id: String) -> URL? {
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
        config.httpShouldSetCookies = false
        let session = URLSession(configuration: config, delegate: Redirects(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: endpoint, timeoutInterval: 5)
        request.setValue("down_mima=ok", forHTTPHeaderField: "Cookie")
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
