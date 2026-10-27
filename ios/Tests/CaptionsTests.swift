import XCTest
@testable import Murmurcut

final class CaptionsTests: XCTestCase {
    func testWordsSplitRunsAndJoinPunctuation() {
        let w = Captions.words(from: [("Hello", 0, 0.5), (" there", 0.5, 1), (".", 1, 1.1), ("big day", 2, 3.6)], romanize: false)
        XCTAssertEqual(w.map(\.text), [" Hello", " there.", " big", " day"])
        XCTAssertEqual(w[1].timestamp, [0.5, 1])
        XCTAssertEqual(w[2].timestamp[0], 2, accuracy: 1e-9)
        XCTAssertEqual(w[3].timestamp[1], 3.6, accuracy: 1e-9)
    }

    func testHinglishSpelling() {
        XCTAssertEqual(Captions.latin("नाम"), "naam")
        XCTAssertEqual(Captions.latin("आज"), "aaj")
        XCTAssertEqual(Captions.latin("हिंदी"), "hindi")
        XCTAssertEqual(Captions.latin("PS5"), "PS5")
    }
}
