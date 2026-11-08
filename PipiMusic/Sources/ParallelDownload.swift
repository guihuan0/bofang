import Foundation

enum ParallelDownload {
    typealias Completion = (Result<URL, Error>) -> Void

    static func start(_ request: URLRequest, workers: Int,
                      progress: @escaping (Int, Int) -> Void,
                      completion: @escaping Completion) {
        guard workers > 1 else { single(request, completion: completion); return }

        var probe = request
        probe.setValue("bytes=0-0", forHTTPHeaderField: "Range")
        URLSession.shared.downloadTask(with: probe) { file, response, error in
            if let file = file, let http = response as? HTTPURLResponse,
               error == nil, validAudio(http), http.statusCode == 200 {
                completion(.success(file))
                return
            }
            guard error == nil, let http = response as? HTTPURLResponse,
                  validAudio(http), http.statusCode == 206,
                  let header = http.value(forHTTPHeaderField: "Content-Range"),
                  header.hasPrefix("bytes 0-0/"),
                  let total = Int(header.dropFirst("bytes 0-0/".count)), total > 0 else {
                single(request, completion: completion)
                return
            }
            let count = min(workers, max(1, total / (256 * 1024)))
            guard count > 1 else { single(request, completion: completion); return }
            let validator: String? = http.value(forHTTPHeaderField: "ETag")
                .flatMap { $0.hasPrefix("W/") ? nil : $0 }
                ?? http.value(forHTTPHeaderField: "Last-Modified")
            fetchParts(request, total: total, count: count, validator: validator,
                       progress: progress, completion: completion)
        }.resume()
    }

    private static func validAudio(_ response: HTTPURLResponse) -> Bool {
        guard let mime = response.mimeType?.lowercased() else { return false }
        return mime.hasPrefix("audio/") || mime == "application/octet-stream"
    }

    private static func single(_ request: URLRequest, completion: @escaping Completion) {
        URLSession.shared.downloadTask(with: request) { file, response, error in
            if let error = error { completion(.failure(error)); return }
            guard let file = file, let http = response as? HTTPURLResponse,
                  http.statusCode == 200, validAudio(http),
                  let length = try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                  length > 0 else {
                completion(.failure(PipiError.message("音源未返回完整音频")))
                return
            }
            completion(.success(file))
        }.resume()
    }

    private static func fetchParts(_ request: URLRequest, total: Int, count: Int,
                                   validator: String?, progress: @escaping (Int, Int) -> Void,
                                   completion: @escaping Completion) {
        let fm = FileManager.default
        let stage = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do { try fm.createDirectory(at: stage, withIntermediateDirectories: false) }
        catch { completion(.failure(error)); return }

        let group = DispatchGroup()
        let state = DispatchQueue(label: "pipi.download.parts")
        let config = URLSessionConfiguration.ephemeral
        config.httpMaximumConnectionsPerHost = count
        let session = URLSession(configuration: config)
        var received = 0
        progress(0, total)
        for index in 0..<count {
            let start = (total / count) * index
            let end = index == count - 1 ? total - 1 : start + total / count - 1
            let range = "\(start)-\(end)"
            let part = stage.appendingPathComponent(String(index))
            var req = request
            req.setValue("bytes=\(range)", forHTTPHeaderField: "Range")
            if let validator = validator { req.setValue(validator, forHTTPHeaderField: "If-Range") }
            group.enter()
            session.downloadTask(with: req) { file, response, error in
                defer { group.leave() }
                guard error == nil, let file = file, let http = response as? HTTPURLResponse,
                      http.statusCode == 206,
                      http.value(forHTTPHeaderField: "Content-Range") == "bytes \(range)/\(total)",
                      (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) == end - start + 1,
                      (try? fm.moveItem(at: file, to: part)) != nil else { return }
                state.sync {
                    received += end - start + 1
                    progress(received, total)
                }
            }.resume()
        }
        group.notify(queue: state) {
            defer {
                session.finishTasksAndInvalidate()
                try? fm.removeItem(at: stage)
            }
            guard received == total else {
                progress(0, 0)
                single(request, completion: completion)
                return
            }
            do {
                let output = stage.appendingPathComponent("audio")
                guard fm.createFile(atPath: output.path, contents: nil) else {
                    throw PipiError.message("无法创建下载文件")
                }
                let writer = try FileHandle(forWritingTo: output)
                defer { try? writer.close() }
                for index in 0..<count {
                    let reader = try FileHandle(forReadingFrom: stage.appendingPathComponent(String(index)))
                    defer { try? reader.close() }
                    while let chunk = try reader.read(upToCount: 256 * 1024), !chunk.isEmpty {
                        try writer.write(contentsOf: chunk)
                    }
                }
                try writer.synchronize()
                completion(.success(output))
            } catch { completion(.failure(error)) }
        }
    }
}
