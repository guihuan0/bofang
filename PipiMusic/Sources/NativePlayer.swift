import AVFoundation
import MediaPlayer
import UIKit

/// All calls and player state updates run on the main queue.
final class NativePlayer {
    private let player = AVPlayer()
    private let emit: (String, [String: Any]) -> Void
    private var status: NSKeyValueObservation?
    private var transport: NSKeyValueObservation?
    private var startupFallback: DispatchWorkItem?
    private var ended: NSObjectProtocol?
    private var tick: Any?
    private var probe: URLSessionDataTask?
    private var loader: AudioRangeLoader?
    private var prepared: (url: URL, asset: AVURLAsset, loader: AudioRangeLoader?)?
    private var prepareTask: URLSessionDataTask?
    private var prepareID = UUID()
    private var url: URL?
    private var token = 0
    private var wantsPlay = false
    private var loop = false
    private var title = ""
    private var artist = ""
    private var remoteTargets: [(MPRemoteCommand, Any)] = []
    private lazy var artwork: MPMediaItemArtwork? = {
        guard let url = Bridge.nowPlayingIconURL, let image = UIImage(contentsOfFile: url.path) else { return nil }
        let bounds = CGRect(origin: .zero, size: image.size)
        let format = UIGraphicsImageRendererFormat()
        format.opaque = true
        format.scale = image.scale
        let circular = UIGraphicsImageRenderer(size: bounds.size, format: format).image { context in
            UIColor.black.setFill()
            context.fill(bounds)
            UIBezierPath(ovalIn: bounds).addClip()
            image.draw(in: bounds)
        }
        return MPMediaItemArtwork(boundsSize: circular.size) { _ in circular }
    }()

    init(emit: @escaping (String, [String: Any]) -> Void) {
        self.emit = emit
        transport = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async {
                guard let self = self, self.wantsPlay else { return }
                if self.player.timeControlStatus == .playing {
                    self.startupFallback?.cancel()
                    self.send("play")
                    self.publish()
                } else if self.player.timeControlStatus == .waitingToPlayAtSpecifiedRate {
                    self.send("waiting")
                }
            }
        }
        tick = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 4), queue: .main) { [weak self] _ in
            self?.send("timeupdate")
        }
        let center = MPRemoteCommandCenter.shared()
        bind(center.playCommand) { owner, _ in owner.play() }
        bind(center.pauseCommand) { owner, _ in owner.pause() }
        bind(center.togglePlayPauseCommand) { owner, _ in
            if owner.wantsPlay { owner.pause() } else { owner.play() }
        }
        bind(center.nextTrackCommand) { owner, _ in owner.send("remoteNext") }
        bind(center.previousTrackCommand) { owner, _ in owner.send("remotePrev") }
        bind(center.changePlaybackPositionCommand) { owner, event in
            if let event = event as? MPChangePlaybackPositionCommandEvent { owner.seek(event.positionTime) }
        }
    }

    deinit {
        if let tick = tick { player.removeTimeObserver(tick) }
        if let ended = ended { NotificationCenter.default.removeObserver(ended) }
        remoteTargets.forEach { $0.0.removeTarget($0.1) }
        probe?.cancel()
        prepareTask?.cancel()
    }

    private func bind(_ command: MPRemoteCommand, handler: @escaping (NativePlayer, MPRemoteCommandEvent) -> Void) {
        command.isEnabled = true
        let target = command.addTarget { [weak self] event in
            guard self != nil else { return .commandFailed }
            DispatchQueue.main.async { [weak self] in
                if let self = self { handler(self, event) }
            }
            return .success
        }
        remoteTargets.append((command, target))
    }

    func load(_ url: URL, token: Int, title: String, artist: String, workers: Int) {
        startupFallback?.cancel()
        probe?.cancel()
        probe = nil
        status = nil
        if let ended = ended { NotificationCenter.default.removeObserver(ended) }
        player.pause()
        player.replaceCurrentItem(with: nil)
        loader = nil
        self.token = token
        self.url = url
        self.title = title
        self.artist = artist
        wantsPlay = false
        let ready = prepared
        prepared = nil
        prepareTask?.cancel()
        prepareID = UUID()
        if let ready = ready, ready.url == url {
            install(url, loader: ready.loader, asset: ready.asset)
            return
        }
        if workers > 1, ["http", "https"].contains(url.scheme ?? "") {
            probe = AudioRangeLoader.probe(url, workers: workers) { [weak self] loader in
                DispatchQueue.main.async {
                    guard let self = self, self.token == token else { return }
                    self.probe = nil
                    self.install(url, loader: loader)
                }
            }
            probe?.resume()
        } else {
            install(url, loader: nil)
        }
    }

    func prepare(_ url: URL, workers: Int) {
        prepareTask?.cancel()
        let id = UUID()
        prepareID = id
        prepared = nil
        func warm(_ loader: AudioRangeLoader?) {
            guard prepareID == id else { return }
            let asset = makeAsset(url, loader: loader)
            prepared = (url, asset, loader)
            asset.loadValuesAsynchronously(forKeys: ["playable", "tracks", "duration"], completionHandler: nil)
        }
        if workers > 1, ["http", "https"].contains(url.scheme ?? "") {
            prepareTask = AudioRangeLoader.probe(url, workers: workers) { loader in
                DispatchQueue.main.async { warm(loader) }
            }
            prepareTask?.resume()
        } else {
            warm(nil)
        }
    }

    private func makeAsset(_ url: URL, loader: AudioRangeLoader?) -> AVURLAsset {
        if let loader = loader, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            parts.scheme = "pipirange"
            let asset = AVURLAsset(url: parts.url ?? url)
            asset.resourceLoader.setDelegate(loader, queue: loader.queue)
            return asset
        }
        return AVURLAsset(url: url)
    }

    private func install(_ url: URL, loader: AudioRangeLoader?, resumeAt: Double = 0, asset: AVURLAsset? = nil) {
        self.loader = loader
        let item = AVPlayerItem(asset: asset ?? makeAsset(url, loader: loader))
        status = nil
        if let ended = ended { NotificationCenter.default.removeObserver(ended) }
        player.replaceCurrentItem(with: item)
        status = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self = self, self.player.currentItem === item else { return }
                if item.status == .readyToPlay {
                    if resumeAt > 0 { self.seek(resumeAt) }
                    self.send("loadedmetadata")
                    if self.wantsPlay { self.player.play() }
                    self.publish()
                } else if item.status == .failed {
                    if self.loader != nil, let original = self.url {
                        self.install(original, loader: nil, resumeAt: self.position)
                    } else {
                        self.wantsPlay = false
                        self.send("error")
                        self.publish()
                    }
                }
            }
        }
        ended = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime,
                                                        object: item, queue: .main) { [weak self] _ in
            guard let self = self else { return }
            if self.loop {
                self.player.seek(to: .zero) { [weak self] finished in
                    if finished, self?.wantsPlay == true { self?.player.play() }
                }
            } else {
                self.wantsPlay = false
                self.send("ended")
                self.publish()
            }
        }
        if wantsPlay, resumeAt == 0 {
            player.play()
            monitorRangeStartup()
        }
    }

    private func monitorRangeStartup() {
        startupFallback?.cancel()
        guard loader != nil, let url = url else { return }
        let currentToken = token
        let fallback = DispatchWorkItem { [weak self] in
            guard let self = self, self.token == currentToken, self.wantsPlay,
                  self.loader != nil, self.player.timeControlStatus != .playing else { return }
            self.install(url, loader: nil, resumeAt: self.position)
        }
        startupFallback = fallback
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: fallback)
    }

    func play() {
        guard url != nil else { return }
        do {
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            NSLog("[pipi] could not activate audio session: \(error)")
        }
        if !wantsPlay, duration > 0, position >= duration - 0.05 { seek(0) }
        wantsPlay = true
        player.play()
        if player.timeControlStatus == .playing { send("play") }
        else { send("waiting") }
        monitorRangeStartup()
        publish()
    }

    func pause() {
        startupFallback?.cancel()
        wantsPlay = false
        player.pause()
        send("pause")
        publish()
    }

    func stop(token: Int) {
        startupFallback?.cancel()
        self.token = token
        wantsPlay = false
        probe?.cancel()
        probe = nil
        prepareTask?.cancel()
        prepareID = UUID()
        prepared = nil
        status = nil
        if let ended = ended { NotificationCenter.default.removeObserver(ended) }
        ended = nil
        player.pause()
        player.replaceCurrentItem(with: nil)
        loader = nil
        url = nil
        title = ""
        artist = ""
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    func seek(_ time: Double) {
        guard time.isFinite else { return }
        let destination = max(0, duration > 0 ? min(time, duration) : time)
        let currentToken = token
        player.seek(to: CMTime(seconds: destination, preferredTimescale: 1000),
                    toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            DispatchQueue.main.async {
                guard let self = self, finished, self.token == currentToken else { return }
                self.send("seeked")
                self.send("timeupdate")
                self.publish()
            }
        }
    }

    func setLoop(_ enabled: Bool) { loop = enabled }
    func setVolume(_ value: Float) { player.volume = min(1, max(0, value)) }

    private var position: Double {
        let value = player.currentTime().seconds
        return value.isFinite ? value : 0
    }

    private var duration: Double {
        let value = player.currentItem?.duration.seconds ?? 0
        return value.isFinite ? value : 0
    }

    private func send(_ name: String) {
        emit(name, ["token": token, "position": position, "duration": duration, "paused": !wantsPlay])
    }

    func publish() {
        guard !title.isEmpty else { return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title, MPMediaItemPropertyArtist: artist,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: player.timeControlStatus == .playing ? Double(player.rate) : 0.0,
        ]
        info[MPMediaItemPropertyArtwork] = artwork
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}
