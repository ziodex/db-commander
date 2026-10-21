import CoreGraphics
import Foundation

// Only change the disposable Actions desktop, never a developer's display.
guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true",
      ProcessInfo.processInfo.environment["RUNNER_ENVIRONMENT"] == "github-hosted" else {
    fatalError("Display preparation requires a GitHub-hosted Actions runner.")
}

let display = CGMainDisplayID()
let modes = CGDisplayCopyAllDisplayModes(display, nil) as? [CGDisplayMode] ?? []
let suitable = modes.filter { $0.width >= 1920 && $0.height >= 1080 }
    .sorted { $0.width * $0.height < $1.width * $1.height }
guard let mode = suitable.first else {
    fatalError("No desktop mode at least 1920x1080; available: \(modes.map { "\($0.width)x\($0.height)" })")
}
let result = CGDisplaySetDisplayMode(display, mode, nil)
guard result == .success, let actual = CGDisplayCopyDisplayMode(display),
      actual.width >= 1920, actual.height >= 1080 else {
    fatalError("Cannot prepare the CI display: \(result)")
}
print("CI display: \(actual.width)x\(actual.height)")
