import Foundation
import os

/// What happened before something went wrong on the phone: page errors, status messages, taps, page kills and the native
/// caption steps, each with the app's free memory. Saved as Documents/murmurcut-log.txt, which the Files app shows under
/// On My iPhone > murmurcut.
enum DebugLog {
    static let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("murmurcut-log.txt")
    private static let queue = DispatchQueue(label: "DebugLog")

    static func add(_ text: String) {
        let line = "\(Date().formatted(.iso8601)) [\(os_proc_available_memory() >> 20) MB free] \(text)\n"
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

    /// Runs in the page before app.js: forwards errors, warnings, status messages, taps and changes to `add`.
    static let pageScript = """
    (() => {
      const send = (kind, msg) => { try { webkit.messageHandlers.log.postMessage(kind + ': ' + String(msg).slice(0, 2000)); } catch {} };
      for (const k of ['error', 'warn']) { const f = console[k]; console[k] = (...a) => { send(k, a.map(x => x?.stack || x).join(' ')); f.apply(console, a); }; }
      addEventListener('error', e => send('error', `${e.message} at ${e.filename}:${e.lineno}`));
      addEventListener('unhandledrejection', e => send('rejection', e.reason?.stack || e.reason));
      addEventListener('click', e => { const b = e.target.closest?.('button'); if (b) send('tap', b.id || b.textContent.trim().slice(0, 40)); }, true);
      addEventListener('change', e => { const t = e.target, f = t.files?.[0]; send('change', `${t.id}=${f ? `${f.name} ${f.type} ${(f.size / 1e6).toFixed(1)} MB` : t.value}`); }, true);
      addEventListener('DOMContentLoaded', () => {
        const s = document.getElementById('status');
        if (s) new MutationObserver(() => send('status', s.textContent.trim())).observe(s, { childList: true, characterData: true, subtree: true });
        const v = document.querySelector('video');
        if (v) for (const ev of ['loadedmetadata', 'error', 'stalled', 'ended']) v.addEventListener(ev, () => send('video', `${ev} ${v.videoWidth}x${v.videoHeight} ${v.duration?.toFixed?.(1)}s`));
      });
      send('page', 'loaded');
    })();
    """
}
