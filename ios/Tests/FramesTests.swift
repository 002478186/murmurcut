import XCTest
@testable import Murmurcut

/// Temporary: Auto B-roll on sample transcripts, printing what it would show.
final class FramesTests: XCTestCase {
    func run(_ said: [String]) async -> String {
        var p = Project(duration: Double(said.count) * 6)
        for (i, s) in said.enumerated() {
            p.words += s.split(separator: " ").enumerated().map { j, w in Word(text: String(w), start: Double(i) * 6 + Double(j) * 0.3, end: Double(i) * 6 + Double(j) * 0.3 + 0.25) }
        }
        var (moments, names) = await BRoll.plan(p)
        var used: Set<String> = []
        for i in moments.indices {
            moments[i].options = await BRoll.search(moments[i].query, kind: moments[i].kind, names: names)
            if let fresh = moments[i].options.indices.first(where: { !used.contains(moments[i].options[$0].url) }) { moments[i].pick = fresh; used.insert(moments[i].options[fresh].url) }
        }
        return "names \(names)\n" + moments.map { "  \($0.kind) \($0.query) -> \($0.options[safe: $0.pick]?.about.prefix(70) ?? "NOTHING")" }.joined(separator: "\n")
    }

    func testGameAndKeys() async {
        let game = ["Hey guys welcome back to the channel, today we are finally playing the new PS5 game everyone was waiting for.",
                    "Ghost of Yotei looks unbelievable on the PS5, the graphics are so detailed.", "The combat is all about the katana, every sword fight feels heavy.",
                    "Bhai yeh horse riding wala part toh kamaal ka hai.", "The open world has mountains, snow and fields of flowers everywhere.",
                    "I played it with the DualSense controller and the vibration is crazy.", "Overall I give it a nine out of ten, buy it."]
        let keys = ["How to make keys in Canada?", "aapko chabi banani ho to Canada mein kaise banate hai, thik hai chalo dekhte hai.", "Walmart mein aa jayenge.",
                    "Insert your old key into the machine with the teeth facing up.", "Get a free brass key.", "So thank you so much for watching guys."]
        print("GAME", await run(game))
        print("KEYS", await run(keys))
    }
}
