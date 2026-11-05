import AVFoundation
import PhotosUI
import SwiftUI

struct HomeView: View {
    @State private var projects = Project.all()
    @State private var path: [Project] = []
    @State private var picked: PhotosPickerItem?
    @State private var recording = false
    @State private var importing = false

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    hero
                    if projects.isEmpty { empty } else { grid }
                }
                .padding(.horizontal, 20).padding(.bottom, 40)
            }
            .background(Theme.bg.ignoresSafeArea())
            .navigationDestination(for: Project.self) { EditorView(project: $0) }
            .onAppear { projects = Project.all() }
            .overlay { if importing { ProgressView("Importing…").padding(24).background(.ultraThinMaterial, in: .rect(cornerRadius: 20)) } }
        }
        .onChange(of: picked) { _, item in
            guard let item else { return }
            Task {
                importing = true
                if let movie = try? await item.loadTransferable(type: Movie.self) { await open(movie.url) }
                importing = false
                picked = nil
            }
        }
        .fullScreenCover(isPresented: $recording) {
            Camera { url in Task { await open(url) } }.ignoresSafeArea()
        }
    }

    private var hero: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 12) {
                Image("Logo").resizable().frame(width: 48, height: 48)
                    .clipShape(.rect(cornerRadius: 12))
                    .shadow(color: Theme.pink.opacity(0.4), radius: 12, y: 4)
                    .accessibilityHidden(true)
                Text("murmurcut")
                    .font(.system(size: 40, weight: .black, design: .rounded))
                    .foregroundStyle(Theme.brand)
            }
            .padding(.top, 12)
            Text("Captions that move, cuts that land.\nPrivate and on your phone.")
                .font(.title3.weight(.medium))
                .foregroundStyle(Theme.muted)
            HStack(spacing: 12) {
                PhotosPicker(selection: $picked, matching: .videos) {
                    Label("New video", systemImage: "plus").frame(maxWidth: .infinity)
                }
                .buttonStyle(BrandButton())
                Button { recording = true } label: {
                    Label("Record", systemImage: "video.fill")
                        .font(.headline).frame(maxWidth: .infinity, minHeight: 50)
                        .background(Theme.raised, in: .capsule)
                        .overlay(Capsule().strokeBorder(Theme.line))
                }
                .buttonStyle(.plain)
                .disabled(!UIImagePickerController.isSourceTypeAvailable(.camera))
            }
        }
    }

    private var empty: some View {
        VStack(spacing: 14) {
            Image(systemName: "captions.bubble.fill")
                .font(.system(size: 44)).foregroundStyle(Theme.brand)
            Text("No videos yet").font(.headline)
            Text("Pick a talking clip. murmurcut writes the captions, animates them word by word and cuts the ums.")
                .font(.subheadline).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity).padding(32)
        .background(Theme.surface, in: .rect(cornerRadius: 24))
        .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(Theme.line))
    }

    private var grid: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Your videos").font(.title3.bold())
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)], spacing: 14) {
                ForEach(projects) { p in
                    NavigationLink(value: p) { card(p) }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button("Delete", systemImage: "trash", role: .destructive) { p.delete(); projects = Project.all() }
                        }
                }
            }
        }
    }

    private func card(_ p: Project) -> some View {
        Color.clear.aspectRatio(9 / 14, contentMode: .fit)
            .overlay { AsyncImage(url: p.thumbnail) { $0.resizable().scaledToFill() } placeholder: { Theme.surface } }
            .overlay(alignment: .bottomLeading) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(Duration.seconds(p.duration).formatted(.time(pattern: .minuteSecond))).font(.caption.monospacedDigit().bold())
                    Text(p.created.formatted(.relative(presentation: .named))).font(.caption2).foregroundStyle(.white.opacity(0.7))
                }
                .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(LinearGradient(colors: [.clear, .black.opacity(0.75)], startPoint: .top, endPoint: .bottom))
            }
            .overlay(alignment: .topTrailing) {
                if p.captioned { Image(systemName: "captions.bubble.fill").font(.caption).padding(7).background(.ultraThinMaterial, in: .circle).padding(8) }
            }
            .clipShape(.rect(cornerRadius: 18))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.line))
            .accessibilityLabel("Video from \(p.created.formatted())")
    }

    /// Makes a project from a video file and opens it.
    private func open(_ url: URL) async {
        var p = Project()
        do {
            try FileManager.default.createDirectory(at: p.folder, withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: url, to: p.video)
            let asset = AVURLAsset(url: p.video)
            p.duration = try await asset.load(.duration).seconds
            let thumbs = AVAssetImageGenerator(asset: asset)
            thumbs.appliesPreferredTrackTransform = true
            thumbs.maximumSize = CGSize(width: 600, height: 600)
            if let image = try? await thumbs.image(at: .zero).image { try? UIImage(cgImage: image).jpegData(compressionQuality: 0.8)?.write(to: p.thumbnail) }
            p.save()
            projects = Project.all()
            DebugLog.add("import: \(Int(p.duration)) s video")
            path.append(p)
        } catch {
            DebugLog.add("import failed: \(error)")
            p.delete()
        }
    }
}

/// A video from the photo library, copied somewhere we can keep it.
struct Movie: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { SentTransferredFile($0.url) } importing: {
            let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension($0.file.pathExtension)
            try FileManager.default.copyItem(at: $0.file, to: copy)
            return Movie(url: copy)
        }
    }
}

/// The system camera, filming video.
struct Camera: UIViewControllerRepresentable {
    let done: (URL) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let c = UIImagePickerController()
        c.sourceType = .camera
        c.mediaTypes = ["public.movie"]
        c.videoQuality = .typeHigh
        c.videoMaximumDuration = 600
        c.delegate = context.coordinator
        return c
    }

    func updateUIViewController(_ c: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: Camera
        init(_ parent: Camera) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let url = info[.mediaURL] as? URL {
                let copy = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mov")
                try? FileManager.default.copyItem(at: url, to: copy)
                parent.done(copy)
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}
