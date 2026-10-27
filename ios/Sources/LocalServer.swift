import Foundation
import Network
import UniformTypeIdentifiers

/// Serves the bundled web app on http://127.0.0.1, because ES modules, workers and WebCodecs need a real origin, not file://.
final class LocalServer {
    static let shared = LocalServer(root: Bundle.main.url(forResource: "Web", withExtension: nil)!)
    // Fixed, so the origin stays the same between launches and the downloaded speech models stay cached.
    static let port: NWEndpoint.Port = 8723

    let root: URL
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "LocalServer")

    init(root: URL) { self.root = root.standardizedFileURL }

    func start() async throws -> URL {
        let params = NWParameters.tcp
        params.requiredInterfaceType = .loopback
        params.allowLocalEndpointReuse = true
        let listener = try NWListener(using: params, on: Self.port)
        self.listener = listener
        listener.newConnectionHandler = { [weak self] c in self?.serve(c) }
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            var resumed = false
            listener.stateUpdateHandler = { state in
                guard !resumed else { return }
                switch state {
                case .ready: resumed = true; done.resume()
                case .failed(let e): resumed = true; done.resume(throwing: e)
                default: break
                }
            }
            listener.start(queue: queue)
        }
        return URL(string: "http://127.0.0.1:\(Self.port)/")!
    }

    private func serve(_ c: NWConnection) {
        c.start(queue: queue)
        readHead(c, Data())
    }

    private func readHead(_ c: NWConnection, _ soFar: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, done, error in
            var buf = soFar
            if let data { buf.append(data) }
            guard let end = buf.range(of: Data("\r\n\r\n".utf8)) else {
                if done || error != nil || buf.count > 65536 { c.cancel() } else { self.readHead(c, buf) }
                return
            }
            let reply = self.response(for: String(decoding: buf[..<end.lowerBound], as: UTF8.self))
            c.send(content: reply, completion: .contentProcessed { _ in c.cancel() })
        }
    }

    /// The whole HTTP reply for a request head. Supports single byte ranges, which WebKit asks for on audio and video.
    func response(for head: String) -> Data {
        let lines = head.components(separatedBy: "\r\n")
        let parts = lines[0].split(separator: " ")
        guard parts.count >= 2, parts[0] == "GET" || parts[0] == "HEAD" else { return reply(405, "Method Not Allowed") }
        var path = String(parts[1].prefix { $0 != "?" && $0 != "#" }).removingPercentEncoding ?? ""
        if path.hasSuffix("/") { path += "index.html" }
        let file = root.appendingPathComponent(path).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let body = try? Data(contentsOf: file) else { return reply(404, "Not Found") }

        let ext = file.pathExtension.lowercased()
        let type = ["js": "text/javascript", "mjs": "text/javascript", "wasm": "application/wasm", "json": "application/json"][ext]
            ?? UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        var headers = ["Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-cache"]
        var slice = body, status = 200
        let prefix = "range: bytes="
        if let range = lines.first(where: { $0.lowercased().hasPrefix(prefix) }).map({ $0.dropFirst(prefix.count) }),
           let dash = range.firstIndex(of: "-"), !body.isEmpty {
            let a = Int(range[..<dash]), b = Int(range[range.index(after: dash)...])
            // "a-b", "a-" (to the end) or "-n" (the last n bytes)
            let from = a ?? max(0, body.count - (b ?? 0))
            let to = min(a == nil ? body.count - 1 : (b ?? body.count - 1), body.count - 1)
            guard from <= to else { return reply(416, "Range Not Satisfiable", ["Content-Range": "bytes */\(body.count)"]) }
            slice = body.subdata(in: from..<(to + 1))
            status = 206
            headers["Content-Range"] = "bytes \(from)-\(to)/\(body.count)"
        }
        return reply(status, status == 206 ? "Partial Content" : "OK", headers, parts[0] == "HEAD" ? Data() : slice, length: slice.count)
    }

    private func reply(_ status: Int, _ reason: String, _ headers: [String: String] = [:], _ body: Data = Data(), length: Int? = nil) -> Data {
        var head = "HTTP/1.1 \(status) \(reason)\r\nConnection: close\r\nContent-Length: \(length ?? body.count)\r\n"
        for (k, v) in headers { head += "\(k): \(v)\r\n" }
        return Data((head + "\r\n").utf8) + body
    }
}
