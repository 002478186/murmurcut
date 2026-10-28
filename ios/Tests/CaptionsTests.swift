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

    func testGapsCoverStartMiddleAndEnd() {
        let g = Captions.gaps(in: [("b", 10, 12), ("a", 0.5, 2), ("c", 13, 14)], duration: 30)
        XCTAssertEqual(g.map(\.0), [2, 14])
        XCTAssertEqual(g.map(\.1), [10, 30])
        XCTAssertEqual(Captions.gaps(in: [], duration: 2).count, 0)
    }

    func testGapPiecesAreAtMost20Seconds() {
        let p = Captions.pieces(of: [(2, 10), (14, 60)])
        XCTAssertEqual(p.map(\.0), [2, 14, 29.333333333333336, 44.66666666666667])
        XCTAssertEqual(p.last?.1, 60)
        XCTAssertTrue(p.allSatisfy { $0.1 - $0.0 <= 20 })
    }

    func testHinglishSpelling() {
        XCTAssertEqual(Captions.latin("नाम"), "naam")
        XCTAssertEqual(Captions.latin("आज"), "aaj")
        XCTAssertEqual(Captions.latin("हिंदी"), "hindi")
        XCTAssertEqual(Captions.latin("PS5"), "PS5")
    }
}
