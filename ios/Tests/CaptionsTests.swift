import XCTest
@testable import Murmurcut

final class CaptionsTests: XCTestCase {
    func testWordsSplitRunsAndJoinPunctuation() {
        let w = Captions.words(from: [("Hello", 0, 0.5), (" there", 0.5, 1), (".", 1, 1.1), ("big day", 2, 3.6)], romanize: false)
        XCTAssertEqual(w.map(\.text), ["Hello", "there.", "big", "day"])
        XCTAssertEqual(w[1].end, 1)
        XCTAssertEqual(w[2].start, 2, accuracy: 1e-9)
        XCTAssertEqual(w[3].end, 3.6, accuracy: 1e-9)
    }

    func testGapsCoverStartMiddleAndEnd() {
        let g = Captions.gaps(in: [("b", 10, 12), ("a", 0.5, 2), ("c", 13, 14)], duration: 30)
        XCTAssertEqual(g.map(\.0), [2, 14])
        XCTAssertEqual(g.map(\.1), [10, 30])
        XCTAssertEqual(Captions.gaps(in: [], duration: 2).count, 0)
    }

    func testGapPiecesAreAtMost8Seconds() {
        let p = Captions.pieces(of: [(2, 10), (14, 30)])
        XCTAssertEqual(p.map(\.0), [2, 14, 22])
        XCTAssertEqual(p.last?.1, 30)
        XCTAssertTrue(p.allSatisfy { $0.1 - $0.0 <= 8 })
    }

    func testHinglishSpelling() {
        XCTAssertEqual(Captions.latin("नाम"), "naam")
        XCTAssertEqual(Captions.latin("आज"), "aaj")
        XCTAssertEqual(Captions.latin("हिंदी"), "hindi")
        XCTAssertEqual(Captions.latin("PS5"), "PS5")
        let hinglish = ["आपके": "aapke", "करने": "karne", "देखने": "dekhne", "गया": "gaya", "क्या": "kya", "में": "mein", "हैं": "hain",
                        "भाई": "bhai", "गए": "gaye", "होता": "hota", "शादी": "shaadi", "चले": "chale", "इसमें": "ismein", "नहीं": "nahi", "है।": "hai.", "करोगे": "karoge"]
        for (hindi, latin) in hinglish { XCTAssertEqual(Captions.latin(hindi), latin, hindi) }
    }

    func testHindiWordsAreHinglishSpellings() {
        XCTAssertTrue(["hai", "kya", "nahi", "dosto"].allSatisfy(Captions.hindiWords.contains))
        XCTAssertFalse(["the", "is", "and", "you"].contains(where: Captions.hindiWords.contains))
    }
}
