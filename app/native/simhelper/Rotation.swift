// Rotating a booted simulator.
//
// First choice: `devicectl device orientation set` (CoreDevice's orientation service in the
// simulator, dthidd). Observed rotating iOS 26.5 and iOS 27.2 simulators on Xcode 26.5 with the
// CoreSimulator/CoreDevice that Xcode 27.2 beta installs. Its XPC message could not be worked out
// (dthidd logs only "decoding failed"), so the helper runs the tool instead of speaking to dthidd.
// Fallback: the GraphicsServices "device orientation changed" event on the device's
// PurpleWorkspacePort, which rotated iOS 26 simulators before CoreDevice was there.
import Foundation
import ObjectiveC

enum Rotation {
  /// UIDeviceOrientation 1…4 -> devicectl's names (same meaning: landscapeLeft = home edge on the right).
  private static let names = [1: "portrait", 2: "portraitUpsideDown", 3: "landscapeLeft", 4: "landscapeRight"]
  /// GraphicsServices: kGSEventDeviceOrientationChanged, sent as a host event, in message id 123.
  private static let orientationEvent: UInt32 = 50 | 0x20000
  private static let purpleMessageId: Int32 = 0x7b
  private static let deviceCtlTimeout: TimeInterval = 20

  private static var devicectl: String? {
    let path = developerDir + "/usr/bin/devicectl"
    return FileManager.default.isExecutableFile(atPath: path) ? path : nil
  }

  static func available(_ device: NSObject) -> Bool {
    devicectl != nil || lookupPort(device, "PurpleWorkspacePort").port != nil
  }

  static func set(_ device: NSObject, _ orientation: Int) throws {
    guard let name = names[orientation] else { throw HelperError("orientation must be 1 to 4.") }
    if let tool = devicectl {
      let error = run(tool, ["device", "orientation", "set", "--device", udidOf(device), name])
      if error == nil { return }
      // Fall through to the older event only where it can reach the device.
      if lookupPort(device, "PurpleWorkspacePort").port == nil { throw HelperError("The simulator did not rotate: \(error!)") }
    }
    try purple(device, UInt32(orientation))
  }

  /// Runs devicectl and returns nil on success or its last line of output.
  private static func run(_ tool: String, _ args: [String]) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: tool)
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    do { try p.run() } catch { return "could not run devicectl (\(error.localizedDescription))" }
    let deadline = Date().addingTimeInterval(deviceCtlTimeout)
    while p.isRunning && Date() < deadline { pause(50) }
    if p.isRunning { p.terminate(); return "devicectl did not finish within \(Int(deviceCtlTimeout)) seconds" }
    if p.terminationStatus == 0 { return nil }
    let text = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    return text.split(separator: "\n").last.map(String.init) ?? "devicectl failed (\(p.terminationStatus))"
  }

  /// A GSEvent "device orientation changed": the mach header, the event type at 24, the record's
  /// info size (4) at 72 and the orientation right after it (layout found by trying, Xcode 26.5).
  private static func purple(_ device: NSObject, _ orientation: UInt32) throws {
    let (port, error) = lookupPort(device, "PurpleWorkspacePort")
    guard let port else { throw HelperError("The simulator has no PurpleWorkspacePort: \(error ?? "no reason given").") }
    let size = 80
    let buffer = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 8)
    defer { buffer.deallocate() }
    memset(buffer, 0, size)
    let header = buffer.assumingMemoryBound(to: mach_msg_header_t.self)
    header.pointee.msgh_bits = UInt32(MACH_MSG_TYPE_COPY_SEND)
    header.pointee.msgh_size = mach_msg_size_t(size)
    header.pointee.msgh_remote_port = port
    header.pointee.msgh_id = purpleMessageId
    buffer.storeBytes(of: orientationEvent, toByteOffset: 24, as: UInt32.self)
    buffer.storeBytes(of: UInt32(4), toByteOffset: 72, as: UInt32.self)
    buffer.storeBytes(of: orientation, toByteOffset: 76, as: UInt32.self)
    let result = mach_msg(header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, mach_msg_size_t(size), 0, 0, 1000, 0)
    if result != KERN_SUCCESS { throw HelperError("The simulator did not take the rotation (mach error \(result)).") }
  }
}
