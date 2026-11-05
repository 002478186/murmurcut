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

    func testSourceTimeUndoesCutsAndSpeed() {
        var p = Project(duration: 5, words: words, cutFillers: true)
        p.speed = 2
        // Kept: 0-0.8 and 1.0-5. Output 0.5 s at 2× is source 1.0 s, which lands just after the cut "um".
        XCTAssertEqual(p.sourceTime(0.2), 0.4, accuracy: 1e-9)
        XCTAssertEqual(p.sourceTime(0.5), 1.2, accuracy: 1e-9)
    }

    func testDeletePartIsBetweenSplitsAndClipEdges() {
        var p = Project(duration: 10)
        p.clips = [Clip(file: "a.mov", duration: 4), Clip(file: "b.mov", duration: 6)]
        p.splits = [2, 7]
        XCTAssertEqual(p.part(at: 3).0, 2); XCTAssertEqual(p.part(at: 3).1, 4)
        XCTAssertEqual(p.part(at: 5).0, 4); XCTAssertEqual(p.part(at: 5).1, 7)
        p.removed = [[4, 7]]
        XCTAssertEqual(p.kept.map { [$0.0, $0.1] }, [[0, 4], [7, 10]])
    }

    func testReorderingClipsMovesTheirWordsAndDeletedParts() {
        var p = Project(duration: 10, words: [Word(text: "first", start: 1, end: 1.5), Word(text: "second", start: 5, end: 5.5)])
        p.clips = [Clip(file: "a.mov", duration: 4), Clip(file: "b.mov", duration: 6)]
        p.removed = [[3, 6]] // crosses from clip a into clip b
        let q = p.rearranged([1, 0])
        XCTAssertEqual(q.clips.map(\.file), ["b.mov", "a.mov"])
        XCTAssertEqual(q.words.map(\.text), ["second", "first"])
        XCTAssertEqual(q.words.map(\.start), [1, 7])
        XCTAssertEqual(q.removed.sorted { $0[0] < $1[0] }, [[0, 2], [9, 10]])
        let r = p.rearranged([1]) // clip a deleted
        XCTAssertEqual(r.duration, 6)
        XCTAssertEqual(r.words.map(\.text), ["second"])
        XCTAssertEqual(r.words[0].start, 1)
    }

    func testTranslationKeepsTheSentenceTiming() {
        var p = Project(duration: 5, words: words)
        XCTAssertEqual(p.sentences.map { $0.map(\.text) }, [["So", "um", "hello"], ["there."], ["Next"]])
        let t = Project.spread("Hola amigo", from: 0.5, to: 1.5)
        XCTAssertEqual(t.map(\.text), ["Hola", "amigo"])
        XCTAssertEqual(t[0].start, 0.5); XCTAssertEqual(t[1].end, 1.5, accuracy: 1e-9)
        p.translation = t; p.showTranslation = true
        XCTAssertEqual(p.lines(maxWords: 4).first?.words.map(\.text), ["Hola", "amigo"])
    }

    func testBrollMomentsAreSpacedAndDistinct() {
        let m = Project.moments([(2, 5, "brass key", "photo", 9), (3, 6, "key", "gif", 8), (8, 11, "Walmart", "photo", 6),
                                 (10, 12, "brass key", "photo", 7), (12, 14, "thank you", "meme", 4), (0.2, 3, "intro", "photo", 10)])
        XCTAssertEqual(m.map(\.query), ["brass key", "Walmart"]) // "key" too close, the repeat dropped, score 4 and the first second skipped
        XCTAssertEqual(m[0].start, 2.15, accuracy: 1e-9)
        XCTAssertEqual(m.map(\.mode), ["full", "card"])
    }

    func testPictureMatchCountsTheSearchWords() {
        XCTAssertEqual(Project.match("Brass padlock with key", query: "brass key"), 1) // "keys" and "key" are one word
        XCTAssertEqual(Project.match("Valve keys on a brass wind instrument", query: "brass key"), 1)
        XCTAssertEqual(Project.match("Detailed map of South Ossetia", query: "sword fight"), 0)
        XCTAssertEqual(Project.match("PS5 Digital Edition with DualSense controller", query: "game console", names: ["PS5"]), 0.25)
    }
}
