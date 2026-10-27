import XCTest
@testable import Murmurcut

final class LocalServerTests: XCTestCase {
    var server: LocalServer!

    override func setUpWithError() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("sub"), withIntermediateDirectories: true)
        try Data("<h1>hi</h1>".utf8).write(to: root.appendingPathComponent("index.html"))
        try Data("0123456789".utf8).write(to: root.appendingPathComponent("sub/a.js"))
        server = LocalServer(root: root)
    }

    func text(_ head: String) -> String { String(decoding: server.response(for: head), as: UTF8.self) }

    func testIndexAndTypes() {
        XCTAssertTrue(text("GET / HTTP/1.1").hasPrefix("HTTP/1.1 200 OK"))
        XCTAssertTrue(text("GET / HTTP/1.1").hasSuffix("<h1>hi</h1>"))
        XCTAssertTrue(text("GET /sub/a.js?v=2 HTTP/1.1").contains("Content-Type: text/javascript"))
    }

    func testRanges() {
        let r = text("GET /sub/a.js HTTP/1.1\r\nRange: bytes=2-4")
        XCTAssertTrue(r.hasPrefix("HTTP/1.1 206"))
        XCTAssertTrue(r.contains("Content-Range: bytes 2-4/10"))
        XCTAssertTrue(r.hasSuffix("\r\n\r\n234"))
        XCTAssertTrue(text("GET /sub/a.js HTTP/1.1\r\nRange: bytes=7-").hasSuffix("789"))
        XCTAssertTrue(text("GET /sub/a.js HTTP/1.1\r\nRange: bytes=-3").hasSuffix("789"))
        XCTAssertTrue(text("GET /sub/a.js HTTP/1.1\r\nRange: bytes=20-").hasPrefix("HTTP/1.1 416"))
    }

    func testStaysInsideRoot() {
        XCTAssertTrue(text("GET /../../etc/hosts HTTP/1.1").hasPrefix("HTTP/1.1 404"))
        XCTAssertTrue(text("GET /%2e%2e/secret HTTP/1.1").hasPrefix("HTTP/1.1 404"))
        XCTAssertTrue(text("GET /missing.js HTTP/1.1").hasPrefix("HTTP/1.1 404"))
        XCTAssertTrue(text("POST / HTTP/1.1").hasPrefix("HTTP/1.1 405"))
    }
}
