import XCTest
@testable import Murmurcut

final class ProjectTests: XCTestCase {
    let words = [Word(text: "So", start: 0.5, end: 0.8), Word(text: "um", start: 0.8, end: 1.0), Word(text: "hello", start: 1.0, end: 1.5),
                 Word(text: "there.", start: 3.0, end: 3.5), Word(text: "Next", start: 3.6, end: 4.0)]

    func testNothingCutKeepsTheWholeVideo() {
        let p = Project(duration: 5, words: words)
        XCTAssertEqual(p.kept.map { [$0.0, $0.1] }, [[0, 5]])
        XCTAssertEqual(Project(duration: 5, cutPauses: true).kept.map { [$0.0, $0.1] }, [[0, 5]]) // no words: nothing to cut against
    }

    func testFillersAndPausesAreCut() {
        let p = Project(duration: 5, words: words, cutFillers: true, cutPauses: true, maxPause: 0.4)
        // Lead-in silence, the "um", the 1.5 s pause (less padding) and the tail all go.
        XCTAssertEqual(p.kept.map { [$0.0, $0.1] }, [[0.38, 0.8], [1.0, 1.62], [2.88, 4.12]])
        XCTAssertEqual(p.outputDuration, 0.42 + 0.62 + 1.24, accuracy: 1e-9)
        XCTAssertNil(Project.outputTime(0.9, kept: p.kept))
        XCTAssertEqual(Project.outputTime(3.0, kept: p.kept)!, 0.42 + 0.62 + 0.12, accuracy: 1e-9)
    }

    func testLinesBreakAtSentencesAndMoveWithCuts() {
        var p = Project(duration: 5, words: words)
        p.words[2].cut = true
        let lines = p.lines(maxWords: 3)
        XCTAssertEqual(lines.map { $0.words.map(\.text) }, [["So", "um"], ["there."], ["Next"]])
        XCTAssertEqual(lines[1].start, 2.5, accuracy: 1e-9) // 0.5 s of "hello" cut before it
    }

    func testSRT() {
        let srt = Project(duration: 5, words: Array(words.prefix(3))).srt(maxWords: 4)
        XCTAssertEqual(srt, "1\n00:00:00,500 --> 00:00:01,500\nSo um hello\n")
    }

    func testTrimAndSpeed() {
        var p = Project(duration: 5, words: words)
        p.trimIn = 0.1; p.trimOut = 0.8 // keeps 0.5-4 s
        XCTAssertEqual(p.kept.map { [$0.0, $0.1] }, [[0.5, 4]])
        p.speed = 2
        XCTAssertEqual(p.outputDuration, 1.75, accuracy: 1e-9)
        let lines = p.lines(maxWords: 5)
        XCTAssertEqual(lines.first?.start ?? -1, 0, accuracy: 1e-9) // "So" starts the trimmed video
        XCTAssertEqual(lines.last?.words.last?.end ?? -1, (4.0 - 0.5) / 2, accuracy: 1e-9) // "Next" ends at 4 s, sped up
    }

    func testOldProjectsLoadWithNewDefaults() throws {
        var full = try JSONSerialization.jsonObject(with: JSONEncoder().encode(Project(duration: 7, words: words))) as! [String: Any]
        for key in ["speed", "filter", "trimIn", "trimOut", "turns", "heard"] { full[key] = nil }
        let p = try XCTUnwrap(Project.load(JSONSerialization.data(withJSONObject: full)))
        XCTAssertEqual(p.duration, 7)
        XCTAssertEqual(p.words.count, 5)
        XCTAssertEqual(p.speed, 1)
        XCTAssertEqual(p.filter, "Original")
    }

    func testMusicDipsWhileTalkingJoinedAcrossBreaths() {
        let p = Project(duration: 5, words: words)
        // "So um hello" (0.5-1.5) and "there. Next" (3.0-4.0) are 1.5 s apart, so they stay two stretches.
        XCTAssertEqual(p.speech.map { [$0.0, $0.1] }, [[0.5, 1.5], [3.0, 4.0]])
    }
}
