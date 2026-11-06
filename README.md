# 皮皮音乐 · iOS 版

vipp3 / aac.cx / 33ve 三站搜索、播放、歌词、下载。给 **TrollStore（巨魔）** 用的免签名 IPA。

同一份 `Web/` 界面配一套原生 Swift 数据层：JS 只管画界面，网络、解密、落盘都在 Swift 这边。

---

## 目录

```
bofang/
├─ .github/workflows/build.yml   GitHub Actions：macOS 跑一次出 IPA
├─ build.sh                       本地也能跑，和 Actions 用同一份
├─ PipiMusic/
│  ├─ Info.plist                  bundle 配置、ATS 例外、图标声明
│  ├─ Sources/
│  │  ├─ main.swift               UIApplicationMain 入口
│  │  ├─ AppDelegate.swift        window + audio session
│  │  ├─ WebController.swift      WKWebView 壳
│  │  ├─ Bridge.swift             JS ⇄ Swift 桥、下载管理
│  │  ├─ PipiAPI.swift            三音源客户端（验证/搜索/解密/歌词）
│  │  ├─ AES.swift                AES-256-ECB + LRC 解析
│  │  └─ LocalAudioScheme.swift   pipilocal:// 读本地音频
│  └─ Web/
│     ├─ index.html
│     ├─ style.css                桌面版布局
│     ├─ ios.css                  窄屏：底部 tab + 歌词抽屉
│     ├─ app.js                   界面逻辑
│     ├─ ios-shim.js              把 /api/ 请求接到原生桥
│     └─ AppIcon*.png             图标
└─ PipiMusic.ipa                  构建产物
```

---

## 构建

推上去自动跑，不用本地环境：

```bash
git add .
git commit -m "init"
git push
```

`Actions` → `build-ipa` → 跑完在 **Artifacts** 里下 `PipiMusic-ipa`。

本地有 Mac 也能直接：

```bash
./build.sh
```

用的是 `xcrun swiftc` 手工编译 + 组装 `Payload/`，**不依赖 .xcodeproj**，改代码不用同步工程文件。

### 构建环境的三条硬约束

踩过的坑，别改回去：

1. **必须 `runs-on: macos-latest`**
   `macos-14` 这个 label 在这个账号上会被判 `cancelled`——job 创建两秒后直接死，runner 都不分配。
   换成 `macos-latest` 立刻就正常了。

2. **GitHub Free 账号 + 私有仓库 = 没有 macOS runner**
   免费额度只覆盖 Linux/Windows。表现同样是 `cancelled`，日志 zip 只有 22 字节。
   要么仓库改公开（推荐，公开仓库的 Actions 全免费），要么升 Pro。

3. **不要 `-framework CommonCrypto`**
   `CommonCrypto` 不是独立 framework，它在 libSystem 里。
   `import CommonCrypto` 能过编译，但链接时会报 `ld: framework 'CommonCrypto' not found`。

---

## 安装（TrollStore）

1. 把 `PipiMusic.ipa` 传到手机（AirDrop / 文件 App / 局域网）
2. TrollStore 里点开这个 IPA → Install
3. 桌面出现图标，点开即用

`build.sh` 会用 `ldid -S` 做 ad-hoc 签名；没有 `ldid` 就退到 `codesign --sign -`。
TrollStore 对未签名 IPA 也认，两种都能装。

最低 iOS 14。arm64（真机）。

---

## 和桌面版的关系

界面是同一套，下面这层换了：

| | 桌面版 | iOS 版 |
|---|---|---|
| 宿主 | Python + pywebview | Swift + WKWebView |
| 数据层 | 本地 HTTP 服务 | JS 桥直调 Swift |
| 站点请求 | requests | URLSession |
| AES 解密 | pycryptodome | CommonCrypto |
| 音频 | 本地代理带 Range | `<audio>` 直连 CDN |
| 收藏/历史/歌单 | `*.json` 落盘 | `localStorage` |
| 下载 | 多线程 Range | URLSession 下载任务 |

**音频不需要代理**。酷我 CDN 只要请求里不带 Referer 就放行，`<audio src="https://...">` 直接播，
省掉桌面版那层流代理。

**本地文件播放**走自定义 scheme `pipilocal://`，WKWebView 不认 `file://` 的音频。

---

## 已知差异

- **歌单链接导入不可用**。抓 HTML 那套留在 Python 里，iOS 版没搬。
  纯文本歌单（每行 `歌名 - 歌手`）完整可用。
- **下载不做多线程**。iOS 上 `URLSession` 单任务就够快，10MB 几秒钟。
- 音质优选仍然有效：下载时如果当前源给的是 ~1.5MB 的 AAC，会再去 33ve 问一次 320k 的版本。

---

## 调试

Safari → 开发 → 你的 iPhone → 皮皮音乐，能看到 WebView 和 console。

`WebController` 里 `webView.isInspectable = true`（iOS 16.4+）已经打开。

原生日志用 `NSLog`，Xcode 设备窗口或 `idevicesyslog` 能看。
