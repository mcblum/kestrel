// kestrel-sim: Kestrel's bridge to a booted iOS Simulator, for what `xcrun simctl` cannot do.
//
//   kestrel-sim input <udid>    touches, keys, buttons, shake and rotation (Input.swift)
//   kestrel-sim frames <udid>   the screen as a stream of JPEG pictures (Frames.swift)
//   kestrel-sim shot <udid> <maxWidth> <orientation>   one JPEG of the screen
//
// Built from this folder by `pnpm --filter @kestrel/app build:simhelper`, or by the server on
// first use (server/src/sim-helper.ts). Needs Xcode; uses its private CoreSimulator and
// SimulatorKit frameworks, so a new Xcode can break it: it then says what is missing and exits.
import Foundation

let arguments = CommandLine.arguments
let mode = arguments.count > 1 ? arguments[1] : ""
guard (["input", "frames"].contains(mode) && arguments.count == 3) || (mode == "shot" && arguments.count == 5) else {
  fail("Usage: kestrel-sim input|frames <device udid>, or kestrel-sim shot <device udid> <maxWidth> <orientation>")
}
signal(SIGPIPE, SIG_IGN)
loadFrameworks()
switch mode {
case "input": runInput(arguments[2])
case "frames": runFrames(arguments[2])
default: runShot(arguments[2], maxWidth: Double(arguments[3]) ?? 800, orientation: Int(arguments[4]) ?? 1)
}
