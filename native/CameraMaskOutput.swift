import Foundation
@preconcurrency import AVFoundation
import CryptoKit
import Darwin

struct CameraCleanupFailure: Error, LocalizedError {
    let cause: Error
    let ownedPaths: [String]
    var errorDescription: String? { "Camera segmentation failed (\(cause.localizedDescription)); owned temporary paths still require cleanup: \(ownedPaths.joined(separator: ", "))." }
}

/// A new private directory is the transaction. No partial output is published.
final class CameraMaskOutput {
    let target: URL
    let temporary: URL
    private let parent: Int32
    private let directory: Int32
    private let directoryIdentity: stat
    private let temporaryName: String
    private var children: [String: stat] = [:]
    private(set) var published = false
    private var removed = false

    init(target: URL) throws {
        self.target = target
        let parentURL = target.deletingLastPathComponent()
        parent = open(parentURL.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard parent >= 0 else { throw CaptureFailure(code: "segmentation_output_failed", message: "The output directory's parent must exist and be accessible.") }
        temporaryName = ".reva-camera-\(UUID().uuidString).tmp"
        temporary = parentURL.appendingPathComponent(temporaryName, isDirectory: true)
        guard mkdirat(parent, temporaryName, S_IRWXU) == 0 else {
            close(parent)
            throw CaptureFailure(code: "segmentation_output_failed", message: "Cannot create a private camera output directory: \(String(cString: strerror(errno)))")
        }
        directory = openat(parent, temporaryName, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        var identity = stat()
        guard directory >= 0, fstat(directory, &identity) == 0 else {
            if directory >= 0 { close(directory) }
            _ = unlinkat(parent, temporaryName, AT_REMOVEDIR)
            close(parent)
            throw CaptureFailure(code: "segmentation_output_failed", message: "Cannot establish camera output directory ownership.")
        }
        directoryIdentity = identity
    }

    deinit { _ = cleanup(); close(directory); close(parent) }

    func url(_ name: String) -> URL { temporary.appendingPathComponent(name) }

    /// The writer alone creates this known child inside our exclusive directory.
    func ownFile(_ name: String) throws {
        guard ["camera-mask.mp4", "manifest.json"].contains(name) else {
            throw CaptureFailure(code: "segmentation_output_failed", message: "Unexpected camera artifact name.")
        }
        var identity = stat()
        guard fstatat(directory, name, &identity, AT_SYMLINK_NOFOLLOW) == 0,
              identity.st_mode & S_IFMT == S_IFREG else {
            throw CaptureFailure(code: "segmentation_output_failed", message: "Cannot establish ownership of \(name).")
        }
        if let previous = children[name], !same(previous, identity) {
            throw CaptureFailure(code: "output_identity_changed", message: "The owned camera artifact \(name) was replaced.")
        }
        children[name] = identity
    }

    func writeManifest<T: Encodable>(_ value: T) throws {
        let fd = openat(directory, "manifest.json", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw CaptureFailure(code: "segmentation_output_failed", message: "Cannot exclusively create the camera manifest.") }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        try ownFile("manifest.json")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(value)
        data.append(0x0a)
        guard data.count <= 64 * 1024 else { throw CaptureFailure(code: "segmentation_output_limit", message: "The camera manifest exceeds its 64KiB bound.") }
        try handle.write(contentsOf: data)
        try handle.synchronize()
    }

    func publish(control: CameraSegmentationControl) throws {
        try control.commit {
            var identity = stat()
            guard fstatat(parent, temporaryName, &identity, AT_SYMLINK_NOFOLLOW) == 0, same(identity, directoryIdentity) else {
                throw CaptureFailure(code: "output_identity_changed", message: "The private camera output directory was replaced before publication.")
            }
            guard children.count == 2 else { throw CaptureFailure(code: "segmentation_output_failed", message: "A camera output transaction is incomplete.") }
            for (name, expected) in children {
                var actual = stat()
                guard fstatat(directory, name, &actual, AT_SYMLINK_NOFOLLOW) == 0, same(expected, actual) else {
                    throw CaptureFailure(code: "output_identity_changed", message: "The camera artifact \(name) was replaced before publication.")
                }
                let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
                guard fd >= 0 else { throw CaptureFailure(code: "segmentation_output_failed", message: "Cannot synchronize \(name).") }
                let sync = fsync(fd)
                close(fd)
                guard sync == 0 else { throw CaptureFailure(code: "segmentation_output_failed", message: "Cannot synchronize \(name).") }
            }
            guard fsync(directory) == 0 else { throw CaptureFailure(code: "segmentation_output_failed", message: "Cannot synchronize the camera transaction.") }
            guard renameatx_np(parent, temporaryName, parent, target.lastPathComponent, UInt32(RENAME_EXCL)) == 0 else {
                throw CaptureFailure(code: errno == EEXIST ? "output_exists" : "segmentation_output_failed", message: "Cannot publish camera output without replacing a path: \(String(cString: strerror(errno)))")
            }
            published = true
            // Commit is irreversible for this owner. A later cancel cannot delete it.
            _ = fsync(parent)
        }
    }

    /// Retains identities when unlink fails, so the same owner can retry cleanup.
    @discardableResult func cleanup() -> [String] {
        if published || removed { return [] }
        var directoryAtPath = stat()
        guard fstatat(parent, temporaryName, &directoryAtPath, AT_SYMLINK_NOFOLLOW) == 0 else {
            if errno == ENOENT { return [temporary.path] }
            return [temporary.path]
        }
        guard same(directoryAtPath, directoryIdentity) else { return [temporary.path] }
        for (name, expected) in children {
            var actual = stat()
            if fstatat(directory, name, &actual, AT_SYMLINK_NOFOLLOW) != 0 {
                if errno == ENOENT { children.removeValue(forKey: name) }
                continue
            }
            guard same(expected, actual) else { continue }
            if unlinkat(directory, name, 0) == 0 { children.removeValue(forKey: name) }
        }
        if children.isEmpty, unlinkat(parent, temporaryName, AT_REMOVEDIR) == 0 { removed = true; return [] }
        return [temporary.path]
    }

    private func same(_ a: stat, _ b: stat) -> Bool { a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_mode & S_IFMT == b.st_mode & S_IFMT }
}

/// The input is held open and checked again before publication, including its digest.
final class CameraInputFile {
    let url: URL
    private let handle: FileHandle
    private let identity: stat

    init(url: URL) throws {
        self.url = url
        let fd = open(url.path, O_RDONLY | O_CLOEXEC)
        var identity = stat()
        guard fd >= 0 else { throw CaptureFailure(code: "input_unavailable", message: "Cannot read the supplied camera video.") }
        guard fstat(fd, &identity) == 0, identity.st_mode & S_IFMT == S_IFREG else {
            close(fd); throw CaptureFailure(code: "input_unavailable", message: "Camera input must be a regular file.")
        }
        self.identity = identity
        handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    }

    func hash(control: CameraSegmentationControl) throws -> String {
        var pathIdentity = stat()
        guard stat(url.path, &pathIdentity) == 0, pathIdentity.st_dev == identity.st_dev, pathIdentity.st_ino == identity.st_ino else {
            throw CaptureFailure(code: "source_changed", message: "The camera input path changed identity during processing.")
        }
        try handle.seek(toOffset: 0)
        var hash = SHA256()
        while true {
            try control.check()
            guard let bytes = try handle.read(upToCount: 1024 * 1024), !bytes.isEmpty else { break }
            hash.update(data: bytes)
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
