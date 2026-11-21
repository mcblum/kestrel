// Finding a simulator through CoreSimulator, and the little Objective-C plumbing the rest needs.
// CoreSimulator and SimulatorKit are private frameworks: everything is looked up at run time, and
// anything missing ends the helper with one JSON line saying what, instead of a crash.
import Foundation
import ObjectiveC

let output = DispatchQueue(label: "kestrel-sim.output")

/// One JSON object as a line on stdout (the input helper's protocol) or stderr (the frame helper's,
/// whose stdout carries pictures).
func emit(_ object: [String: Any], to handle: FileHandle = .standardOutput) {
  guard let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) else { return }
  output.sync { handle.write((line + "\n").data(using: .utf8)!) }
}

/// Every mode starts by saying whether it is ready; a helper that cannot start says why and exits.
var readyHandle: FileHandle = .standardOutput

func fail(_ message: String) -> Never {
  emit(["ready": false, "error": message], to: readyHandle)
  exit(1)
}

let developerDir: String = {
  if let env = ProcessInfo.processInfo.environment["DEVELOPER_DIR"], !env.isEmpty { return env }
  let pipe = Pipe()
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
  p.arguments = ["-p"]
  p.standardOutput = pipe
  try? p.run()
  p.waitUntilExit()
  let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return out.isEmpty ? "/Applications/Xcode.app/Contents/Developer" : out
}()

func loadFrameworks() {
  for path in ["/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator", developerDir + "/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"] {
    if dlopen(path, RTLD_NOW) == nil { fail("Could not load \(path): \(String(cString: dlerror()))") }
  }
}

func classNamed(_ name: String) -> NSObject.Type {
  guard let cls = NSClassFromString(name) as? NSObject.Type else { fail("This Xcode has no \(name) class.") }
  return cls
}

/// Calls an Objective-C method that takes one object and an NSError** and returns an object.
func callWithError(_ target: AnyObject, _ selector: String, _ arg: AnyObject?) -> (AnyObject?, String?) {
  let sel = NSSelectorFromString(selector)
  guard let method = class_getInstanceMethod(object_getClass(target), sel) else { return (nil, "missing method \(selector)") }
  typealias Fn = @convention(c) (AnyObject, Selector, AnyObject?, UnsafeMutablePointer<NSError?>?) -> Unmanaged<AnyObject>?
  var error: NSError?
  let result = unsafeBitCast(method_getImplementation(method), to: Fn.self)(target, sel, arg, &error)?.takeUnretainedValue()
  return (result, error?.localizedDescription)
}

/// The booted SimDevice with this UDID.
func bootedDevice(_ udid: String) -> NSObject {
  let (ctx, ctxError) = callWithError(classNamed("SimServiceContext"), "sharedServiceContextForDeveloperDir:error:", developerDir as NSString)
  guard let ctx else { fail("CoreSimulator did not start: \(ctxError ?? "no reason given").") }
  let (set, setError) = callWithError(ctx, "defaultDeviceSetWithError:", nil)
  guard let set = set as? NSObject else { fail("No simulator device set: \(setError ?? "no reason given").") }
  guard let devices = set.value(forKey: "devices") as? [NSObject] else { fail("Could not list simulator devices.") }
  guard let device = devices.first(where: { ($0.value(forKey: "UDID") as? NSUUID)?.uuidString == udid.uppercased() }) else { fail("No simulator with id \(udid).") }
  guard (device.value(forKey: "state") as? Int) == 3 else { fail("The simulator is not booted.") }
  return device
}

/// The screen in pixels and its scale, from the device type.
func screenOf(_ device: NSObject) -> (pixels: CGSize, scale: Double) {
  let type = device.value(forKey: "deviceType") as? NSObject
  let scale = (type?.value(forKey: "mainScreenScale") as? NSNumber)?.doubleValue ?? 0
  guard let pixels = (type?.value(forKey: "mainScreenSize") as? NSValue)?.sizeValue, scale > 0 else { fail("Could not read the screen size.") }
  return (pixels, scale)
}

func pause(_ ms: Double) { usleep(useconds_t(max(0, ms) * 1000)) }

/// A Mach service in the simulator's own launchd namespace (`-[SimDevice lookup:error:]`), or nil
/// with the reason. CoreDevice's simulator plugin reaches the device's services the same way.
func lookupPort(_ device: NSObject, _ name: String) -> (port: mach_port_t?, error: String?) {
  typealias LookupFn = @convention(c) (AnyObject, Selector, NSString, UnsafeMutablePointer<NSError?>?) -> UInt32
  let sel = NSSelectorFromString("lookup:error:")
  guard let method = class_getInstanceMethod(object_getClass(device), sel) else { return (nil, "this Xcode cannot look up the simulator's services") }
  var error: NSError?
  let port = unsafeBitCast(method_getImplementation(method), to: LookupFn.self)(device, sel, name as NSString, &error)
  return port == 0 ? (nil, error?.localizedDescription ?? "\(name) is not running on the simulator") : (port, nil)
}

/// Posts a Darwin notification inside the simulator (`-[SimDevice postDarwinNotification:error:]`).
/// Simulator.app's Device > Shake posts "com.apple.UIKit.SimulatorShake" this way (Xcode 26.5).
func postDarwinNotification(_ device: NSObject, _ name: String) -> String? {
  typealias PostFn = @convention(c) (AnyObject, Selector, NSString, UnsafeMutablePointer<NSError?>?) -> Bool
  let sel = NSSelectorFromString("postDarwinNotification:error:")
  guard let method = class_getInstanceMethod(object_getClass(device), sel) else { return "this Xcode cannot post notifications to the simulator" }
  var error: NSError?
  let ok = unsafeBitCast(method_getImplementation(method), to: PostFn.self)(device, sel, name as NSString, &error)
  return ok ? nil : (error?.localizedDescription ?? "the simulator did not take the notification")
}

/// True when the device answers to Simulator.app's shake (the selector exists on this CoreSimulator).
func canPostDarwinNotification(_ device: NSObject) -> Bool {
  class_getInstanceMethod(object_getClass(device), NSSelectorFromString("postDarwinNotification:error:")) != nil
}

/// The major OS version of the device's runtime ("27.2" -> 27), 0 when unknown.
func runtimeMajor(_ device: NSObject) -> Int {
  let version = (device.value(forKey: "runtime") as? NSObject)?.value(forKey: "versionString") as? String ?? ""
  return Int(version.split(separator: ".").first ?? "") ?? 0
}

/// The device's UDID as CoreSimulator spells it.
func udidOf(_ device: NSObject) -> String { (device.value(forKey: "UDID") as? NSUUID)?.uuidString ?? "" }

/// Exit with a reason once the device stops being booted (shut down, or Simulator.app quit with it):
/// a helper holding a dead device would otherwise sit there showing the last picture.
private var watchdog: DispatchSourceTimer?
func exitWhenNotBooted(_ device: NSObject) {
  let t = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "kestrel-sim.watchdog"))
  t.schedule(deadline: .now() + 1, repeating: 1)
  t.setEventHandler {
    if (device.value(forKey: "state") as? Int) != 3 { fail("The simulator was shut down.") }
  }
  t.resume()
  watchdog = t
}

struct HelperError: Error {
  let message: String
  init(_ m: String) { message = m }
}

func number(_ request: [String: Any], _ key: String) throws -> Double {
  guard let n = request[key] as? NSNumber, n.doubleValue.isFinite else { throw HelperError("\(key) must be a number.") }
  return n.doubleValue
}

/// Reads JSON requests from stdin on a background thread (the main run loop must keep turning for
/// SimulatorKit), hands each to `handle`, and exits when stdin closes: the server went away.
func serveStdin(_ handle: @escaping ([String: Any]) -> Void) {
  Thread.detachNewThread {
    while let line = readLine() {
      guard let data = line.data(using: .utf8), let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
      handle(request)
    }
    exit(0)
  }
}
