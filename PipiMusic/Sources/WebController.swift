import UIKit
import WebKit

final class WebController: UIViewController, WKNavigationDelegate, WKUIDelegate {

    private var webView: WKWebView!
    private let bridge = Bridge()

    override var preferredStatusBarStyle: UIStatusBarStyle {
        traitCollection.userInterfaceStyle == .dark ? .lightContent : .darkContent
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        if previousTraitCollection?.userInterfaceStyle != traitCollection.userInterfaceStyle {
            setNeedsStatusBarAppearanceUpdate()
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        NotificationCenter.default.addObserver(self, selector: #selector(publishNowPlaying),
                                               name: UIApplication.didEnterBackgroundNotification,
                                               object: nil)
        view.backgroundColor = UIColor { traits in
            if traits.userInterfaceStyle == .dark {
                return UIColor(red: 0.082, green: 0.071, blue: 0.063, alpha: 1)
            }
            return UIColor(red: 0.99, green: 0.97, blue: 0.94, alpha: 1)
        }

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.setURLSchemeHandler(LocalAudioScheme(), forURLScheme: LocalAudioScheme.scheme)

        let ucc = WKUserContentController()
        ucc.add(bridge, name: Bridge.name)
        if let icon = Bridge.nowPlayingIconURL, let data = try? Data(contentsOf: icon) {
            let artwork = "data:image/png;base64,\(data.base64EncodedString())"
            ucc.addUserScript(WKUserScript(source: "window.__pipiSystemArtwork = '\(artwork)';",
                                          injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        config.userContentController = ucc

        // 关掉长按选择和弹出菜单，像个原生 app
        let css = """
        (function(){
          var s=document.createElement('style');
          s.textContent='*{-webkit-touch-callout:none;-webkit-user-select:none;'+
            'user-select:none;-webkit-tap-highlight-color:transparent;}';
          document.addEventListener('DOMContentLoaded',function(){document.head.appendChild(s);});
        })();
        """
        let script = WKUserScript(source: css, injectionTime: .atDocumentStart,
                                  forMainFrameOnly: true)
        ucc.addUserScript(script)

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        bridge.webView = webView

        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        loadUI()
    }

    @objc private func publishNowPlaying() {
        bridge.publishActiveNowPlaying()
    }

    private func loadUI() {
        guard let dir = Bundle.main.url(forResource: "index", withExtension: "html",
                                        subdirectory: "Web") else {
            // 有些打包方式会把 Web 目录拍平，兜个底
            if let flat = Bundle.main.url(forResource: "index", withExtension: "html") {
                webView.loadFileURL(flat, allowingReadAccessTo: flat.deletingLastPathComponent())
            }
            return
        }
        webView.loadFileURL(dir, allowingReadAccessTo: dir.deletingLastPathComponent())
    }

    // 页面里的外链走系统浏览器
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if url.scheme == "http" || url.scheme == "https" {
            if navigationAction.navigationType == .linkActivated {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
                return
            }
        }
        decisionHandler(.allow)
    }

    // 恢复播放时不要弹「需要用户手势」
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("document.body.classList.add('ios');", completionHandler: nil)
    }
}
