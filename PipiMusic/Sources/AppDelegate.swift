import UIKit
import AVFoundation

final class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions:
                        [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let win = UIWindow(frame: UIScreen.main.bounds)
        win.rootViewController = WebController()
        win.makeKeyAndVisible()
        window = win

        // 保持屏幕常亮不必要，但静音开关不影响播放（iOS 上 audio session 设一下）
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [])
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            NSLog("[pipi] audio session failed: \(error)")
        }
        return true
    }
}
