import Foundation
import os

/// What happened before something went wrong on the phone (caption and export steps), each with the app's free memory. Saved as Documents/murmurcut-log.txt, which the Files app shows under
/// On My iPhone > murmurcut.
enum DebugLog {
    static let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("murmurcut-log.txt")
    private static let queue = DispatchQueue(label: "DebugLog")

    static func add(_ text: String) {
        let line = "\(Date().formatted(.iso8601)) [\(os_proc_available_memory() >> 20) MB free] \(text)\n"
        #if DEBUG
        print("LOG", text)
        #endif
        queue.async {
            // Start over past 2 MB, so the log never grows without end.
            if let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 2 << 20 { try? FileManager.default.removeItem(at: url) }
            if let out = try? FileHandle(forWritingTo: url) {
                out.seekToEndOfFile()
                out.write(Data(line.utf8))
                try? out.close()
            } else {
                try? Data(line.utf8).write(to: url)
            }
        }
    }
}
