import SwiftUI
import WebKit

/// The web app in a WKWebView, plus two things a browser tab does for free: saving downloads, and coming back after iOS
/// kills the page for using too much memory.
struct WebView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        // Tells app.js it can send captioning to Apple's speech recognition (Captions.swift).
        config.userContentController.addUserScript(WKUserScript(source: "window.murmurcutApp = true", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .black
        web.navigationDelegate = context.coordinator
        web.load(URLRequest(url: url))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKDownloadDelegate {
        private var files: [WKDownload: URL] = [:]

        func webView(_ web: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            action.shouldPerformDownload ? .download : .allow
        }

        func webView(_ web: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
            download.delegate = self
        }

        // After the reload the page itself says it ran out of memory (app.js keeps a flag in sessionStorage).
        func webViewWebContentProcessDidTerminate(_ web: WKWebView) { web.reload() }

        func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent(suggestedFilename)
            try? FileManager.default.removeItem(at: url)
            files[download] = url
            return url
        }

        func downloadDidFinish(_ download: WKDownload) {
            guard let url = files.removeValue(forKey: download) else { return }
            // The share sheet has "Save Video" for Photos and "Save to Files" for captions.
            let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            var top = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?.rootViewController
            while let shown = top?.presentedViewController { top = shown }
            sheet.popoverPresentationController?.sourceView = top?.view
            top?.present(sheet, animated: true)
        }

        func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
            files.removeValue(forKey: download)
        }
    }
}
