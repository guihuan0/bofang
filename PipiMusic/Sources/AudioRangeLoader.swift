import AVFoundation
import UniformTypeIdentifiers

/// Serves one seekable audio file to AVPlayer using ordered HTTP byte ranges.
final class AudioRangeLoader: NSObject, AVAssetResourceLoaderDelegate {
    static let chunkSize = 128 * 1024
    let queue = DispatchQueue(label: "pipi.playback.ranges")
    private let url: URL
    private let workers: Int
    private let size: Int
    private let type: String
    private let validator: String?
    private let session: URLSession
    private var requests: [ObjectIdentifier: Transfer] = [:]

    private final class Transfer {
        let request: AVAssetResourceLoadingRequest
        let end: Int
        var cursor: Int
        var scheduled: Int
        var chunks: [Int: Data] = [:]
        var tasks: [Int: URLSessionDataTask] = [:]

        init(_ request: AVAssetResourceLoadingRequest, start: Int, end: Int) {
            self.request = request
            self.end = end
            cursor = start
            scheduled = start
        }
    }

    private final class Probe: NSObject, URLSessionDataDelegate {
        var completion: ((HTTPURLResponse?) -> Void)?

        init(_ completion: @escaping (HTTPURLResponse?) -> Void) {
            self.completion = completion
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            let callback = completion
            completion = nil
            completionHandler(.cancel)
            callback?(response as? HTTPURLResponse)
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            completion?(nil)
            completion = nil
            session.finishTasksAndInvalidate()
        }
    }

    static func probe(_ url: URL, workers: Int, completion: @escaping (AudioRangeLoader?) -> Void) -> URLSessionDataTask {
        var request = URLRequest(url: url, timeoutInterval: 5)
        request.setValue("bytes=0-0", forHTTPHeaderField: "Range")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        request.setValue(PipiClient.USER_AGENT, forHTTPHeaderField: "User-Agent")
        let delegate = Probe { response in
            guard let response = response, response.statusCode == 206,
                  let range = response.value(forHTTPHeaderField: "Content-Range"),
                  range.hasPrefix("bytes 0-0/"),
                  let size = Int(range.dropFirst(10)), size > 0 else { completion(nil); return }
            completion(AudioRangeLoader(url: url, workers: workers, size: size, response: response))
        }
        let session = URLSession(configuration: .ephemeral, delegate: delegate, delegateQueue: nil)
        return session.dataTask(with: request)
    }

    private init(url: URL, workers: Int, size: Int, response: HTTPURLResponse) {
        self.url = url
        self.workers = workers
        self.size = size
        type = response.mimeType.flatMap { UTType(mimeType: $0)?.identifier }
            ?? UTType(filenameExtension: url.pathExtension)?.identifier ?? AVFileType.mp3.rawValue
        let etag = response.value(forHTTPHeaderField: "ETag")
        validator = etag.flatMap { $0.hasPrefix("W/") ? nil : $0 } ?? response.value(forHTTPHeaderField: "Last-Modified")
        let config = URLSessionConfiguration.ephemeral
        config.httpMaximumConnectionsPerHost = workers
        session = URLSession(configuration: config)
        super.init()
    }

    deinit { session.invalidateAndCancel() }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader,
                        shouldWaitForLoadingOfRequestedResource request: AVAssetResourceLoadingRequest) -> Bool {
        if let info = request.contentInformationRequest {
            info.contentType = type
            info.contentLength = Int64(size)
            info.isByteRangeAccessSupported = true
        }
        guard let data = request.dataRequest else { request.finishLoading(); return true }
        let start = Int(max(data.requestedOffset, data.currentOffset))
        guard start >= 0, start < size else { request.finishLoading(); return true }
        let requestedEnd = Int(data.requestedOffset) + min(data.requestedLength, size)
        let end = data.requestsAllDataToEndOfResource ? size : min(size, requestedEnd)
        let transfer = Transfer(request, start: start, end: end)
        requests[ObjectIdentifier(request)] = transfer
        pump(transfer)
        return true
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader,
                        didCancel request: AVAssetResourceLoadingRequest) {
        requests.removeValue(forKey: ObjectIdentifier(request))?.tasks.values.forEach { $0.cancel() }
    }

    private func pump(_ transfer: Transfer) {
        while let data = transfer.chunks.removeValue(forKey: transfer.cursor) {
            transfer.request.dataRequest?.respond(with: data)
            transfer.cursor += data.count
        }
        if transfer.cursor >= transfer.end {
            requests.removeValue(forKey: ObjectIdentifier(transfer.request))
            transfer.request.finishLoading()
            return
        }
        while transfer.scheduled < min(transfer.end, transfer.cursor + workers * Self.chunkSize) {
            let start = transfer.scheduled
            let end = min(transfer.end, start + Self.chunkSize)
            transfer.scheduled = end
            let range = "\(start)-\(end - 1)"
            var request = URLRequest(url: url, timeoutInterval: 12)
            request.setValue("bytes=\(range)", forHTTPHeaderField: "Range")
            request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
            request.setValue(PipiClient.USER_AGENT, forHTTPHeaderField: "User-Agent")
            if let validator = validator { request.setValue(validator, forHTTPHeaderField: "If-Range") }
            let task = session.dataTask(with: request) { [weak self, weak transfer] data, response, error in
                guard let self = self, let transfer = transfer else { return }
                self.queue.async {
                    let key = ObjectIdentifier(transfer.request)
                    guard self.requests[key] === transfer else { return }
                    transfer.tasks.removeValue(forKey: start)
                    guard let data = data, data.count == end - start,
                          let http = response as? HTTPURLResponse, http.statusCode == 206,
                          http.value(forHTTPHeaderField: "Content-Range") == "bytes \(range)/\(self.size)" else {
                        self.requests.removeValue(forKey: key)
                        transfer.tasks.values.forEach { $0.cancel() }
                        transfer.request.finishLoading(with: error ?? PipiError.message("音频分段响应异常"))
                        return
                    }
                    transfer.chunks[start] = data
                    self.pump(transfer)
                }
            }
            transfer.tasks[start] = task
            task.resume()
        }
    }
}
