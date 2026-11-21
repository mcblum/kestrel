// `kestrel-sim input <udid>`: touches, keys, buttons, shake and rotation for a booted simulator.
//
// Two input paths, picked when the helper connects (KESTREL_SIM_INPUT=legacy forces the second):
//   - CoreDevice (CoreDeviceHID.swift): dtuhidd inside the simulator. Observed on Xcode 26.5 with
//     CoreSimulator 1174.20 for iOS 26.5 AND iOS 27.2: one- and two-finger touches, edge gestures,
//     the keyboard (text, special keys, modifiers), and the Home, Lock, Siri and volume buttons.
//   - Legacy (LegacyHID below): SimulatorKit's SimDeviceLegacyHIDClient and its Indigo messages, as
//     Simulator.app 26.5 does. One finger only, Home as a swipe up from the bottom edge; keyboard and
//     button messages are accepted by SimulatorKit and ignored by the device (checked on iOS 26.5),
//     and iOS 27 ignores it altogether. Used only where the CoreDevice service is missing.
// Shake is the Darwin notification Simulator.app posts (Device.swift); rotation is Rotation.swift.
//
// Requests, one JSON object per line on stdin; coordinates are device points in the portrait
// frame (origin top-left of the device held upright); `edge` is top|bottom|left|right:
//   {"id":1,"op":"touch","phase":"down"|"move"|"up","x":120,"y":300,"x2":200,"y2":300,"edge":"bottom"}
//   {"id":2,"op":"gesture","steps":[{"phase":"down","x":1,"y":2,"wait":0}, …]}   (wait: ms before the step)
//   {"id":3,"op":"keys","steps":[{"usage":4,"down":true,"wait":0}, …]}           (HID keyboard usages)
//   {"id":4,"op":"button","button":"home"|"lock"|"siri"|"volume_up"|"volume_down","hold":100}
//   {"id":5,"op":"shake"}
//   {"id":6,"op":"orient","orientation":1|2|3|4}   (UIDeviceOrientation)
// Older servers' {"op":"tap","x","y"}, {"op":"swipe","x1","y1","x2","y2","ms"} and {"op":"home"} still work.
// Answers on stdout: {"id":1,"ok":true} or {"id":1,"ok":false,"error":"…"}. The first line is
// {"ready":true,"width":402,"height":874,"scale":3,"input":"coredevice"|"legacy",
//  "capabilities":{"touch","multitouch","keyboard","buttons":[…],"rotate","shake"},"reasons":{…}}
// or {"ready":false,"error":"…"}. `reasons` says why each missing capability is missing.
import AppKit
import Foundation
import ObjectiveC

/// What one input path can do. Only what was seen working on a device is claimed.
struct Capabilities {
  var touch = false
  var multitouch = false
  var keyboard = false
  var buttons: [String] = []
  var rotate = false
  var shake = false
  var reasons: [String: String] = [:]

  var json: [String: Any] { ["touch": touch, "multitouch": multitouch, "keyboard": keyboard, "buttons": buttons, "rotate": rotate, "shake": shake] }
}

/// Consumer-page usages of the hardware buttons (HID Usage Tables, page 0x0C), as dtuhidd takes them.
private let buttonUsages: [String: UInt64] = ["home": 0x40, "lock": 0x30, "siri": 0xCF, "volume_up": 0xE9, "volume_down": 0xEA]
private let consumerPage: UInt64 = 0x0C
/// Edge numbers both paths use (observed with dtuhidd: 1 pulls the cover sheet from the top, 2 is
/// the back swipe from the left, 3 goes Home from the bottom; SimulatorKit's table also has 3 for
/// the bottom). No number for the right edge was found; a touch there is sent without one.
private let edges: [String: UInt32] = ["top": 1, "left": 2, "bottom": 3, "right": 0, "none": 0]
private let maxSteps = 20_000

final class Input {
  private let device: NSObject
  let screen: CGSize
  private let scale: Double
  private let hid: CoreDeviceHID?
  private let legacy: LegacyHID?
  private let caps: Capabilities

  init(device: NSObject) {
    self.device = device
    let (pixels, scale) = screenOf(device)
    self.scale = scale
    screen = CGSize(width: pixels.width / CGFloat(scale), height: pixels.height / CGFloat(scale))
    let opened: (CoreDeviceHID?, String?) = ProcessInfo.processInfo.environment["KESTREL_SIM_INPUT"] == "legacy"
      ? (nil, "KESTREL_SIM_INPUT=legacy")
      : CoreDeviceHID.open(device)
    hid = opened.0
    legacy = opened.0 == nil ? LegacyHID(device: device, screen: screen) : nil
    caps = Input.capabilities(device, hid: opened.0, legacy: legacy, why: opened.1)
  }

  private static func capabilities(_ device: NSObject, hid: CoreDeviceHID?, legacy: LegacyHID?, why: String?) -> Capabilities {
    var caps = Capabilities()
    if hid != nil {
      caps.touch = true
      caps.multitouch = true
      caps.keyboard = true
      caps.buttons = Array(buttonUsages.keys).sorted()
    } else if let legacy {
      let path = "this simulator only takes the older input path (\(why ?? "no CoreDevice HID service"))"
      // iOS 27 runtimes take no input through this path at all (checked on 27.2 with Xcode 26.5).
      let ignored = runtimeMajor(device) >= 27
      caps.touch = legacy.ready && !ignored
      caps.buttons = caps.touch ? ["home"] : []
      if ignored { caps.reasons["touch"] = "iOS 27 ignores the older input path, and \(path)." }
      else if let problem = legacy.problem { caps.reasons["touch"] = problem }
      caps.reasons["multitouch"] = "Two-finger gestures need CoreDevice input: \(path)."
      caps.reasons["keyboard"] = "Typing needs CoreDevice input: \(path), which ignores keyboard events."
      caps.reasons["buttons"] = caps.touch ? "Only Home works: \(path), which ignores hardware buttons." : caps.reasons["touch"]
    }
    caps.rotate = Rotation.available(device)
    if !caps.rotate { caps.reasons["rotate"] = "Neither devicectl nor the simulator's PurpleWorkspacePort is available." }
    caps.shake = canPostDarwinNotification(device)
    if !caps.shake { caps.reasons["shake"] = "This CoreSimulator cannot post notifications to the device." }
    return caps
  }

  var readyLine: [String: Any] {
    ["ready": true, "width": screen.width, "height": screen.height, "scale": scale, "input": hid != nil ? "coredevice" : "legacy", "capabilities": caps.json, "reasons": caps.reasons]
  }

  func handle(_ request: [String: Any]) throws {
    switch request["op"] as? String {
    case "touch":
      try touch(request)
    case "gesture":
      for step in try steps(request) {
        pause((step["wait"] as? NSNumber)?.doubleValue ?? 0)
        try touch(step)
      }
      try settle()
    case "keys":
      try keys(request)
    case "button":
      try button(request["button"] as? String ?? "", hold: (request["hold"] as? NSNumber)?.doubleValue ?? 100)
    case "shake":
      guard caps.shake else { throw HelperError(caps.reasons["shake"] ?? "Shake is not available.") }
      if let error = postDarwinNotification(device, "com.apple.UIKit.SimulatorShake") { throw HelperError("The simulator did not shake: \(error).") }
    case "orient":
      try Rotation.set(device, Int(try number(request, "orientation")))
    // What servers before the CoreDevice path sent.
    case "tap":
      let x = try number(request, "x"), y = try number(request, "y")
      try touch(["phase": "down", "x": x, "y": y])
      pause(60)
      try touch(["phase": "up", "x": x, "y": y])
      try settle()
    case "swipe":
      let ms = min(5000, max(60, (request["ms"] as? NSNumber)?.doubleValue ?? 300))
      try straightSwipe(try number(request, "x1"), try number(request, "y1"), try number(request, "x2"), try number(request, "y2"), ms, edge: nil)
    case "home":
      try button("home", hold: 100)
    default:
      throw HelperError("Unknown op.")
    }
  }

  private func steps(_ request: [String: Any]) throws -> [[String: Any]] {
    guard let steps = request["steps"] as? [[String: Any]], !steps.isEmpty, steps.count <= maxSteps else { throw HelperError("steps must be a list of 1 to \(maxSteps) entries.") }
    return steps
  }

  /// One digitizer report from a request or a gesture step.
  private func touch(_ r: [String: Any]) throws {
    let one = CGPoint(x: try number(r, "x"), y: try number(r, "y"))
    try onScreen(one)
    var two: CGPoint?
    if r["x2"] != nil || r["y2"] != nil {
      let second = CGPoint(x: try number(r, "x2"), y: try number(r, "y2"))
      try onScreen(second)
      two = second
    }
    let edgeName = r["edge"] as? String ?? "none"
    guard let edge = edges[edgeName] else { throw HelperError("edge must be top, bottom, left or right.") }
    let phase = r["phase"] as? String ?? ""
    if let hid {
      try hid.touch(try hidPhase(phase), one, two, edge: UInt64(edge), size: screen)
    } else if let legacy {
      if two != nil { throw HelperError(caps.reasons["multitouch"] ?? "Two-finger gestures are not available.") }
      try legacy.touch(phase, one, edge: edge)
    }
  }

  private func hidPhase(_ phase: String) throws -> CoreDeviceHID.Phase {
    switch phase {
    case "down": return .down
    case "move": return .move
    case "up": return .up
    default: throw HelperError("phase must be down, move or up.")
    }
  }

  private func onScreen(_ p: CGPoint) throws {
    guard p.x >= 0, p.y >= 0, p.x <= screen.width, p.y <= screen.height else {
      throw HelperError("(\(Int(p.x)), \(Int(p.y))) is off the screen, which is \(Int(screen.width))×\(Int(screen.height)) points.")
    }
  }

  /// Waits until the device has taken everything sent (CoreDevice); the legacy client waits per message.
  private func settle() throws { try hid?.barrier() }

  private func keys(_ request: [String: Any]) throws {
    guard let hid else { throw HelperError(caps.reasons["keyboard"] ?? "Typing is not available.") }
    for step in try steps(request) {
      pause((step["wait"] as? NSNumber)?.doubleValue ?? 0)
      let usage = try number(step, "usage")
      guard usage >= 1, usage <= 0xFFFF else { throw HelperError("usage must be a HID keyboard usage.") }
      try hid.key(usage: UInt64(usage), down: step["down"] as? Bool ?? false)
    }
    try settle()
  }

  private func button(_ name: String, hold: Double) throws {
    guard let usage = buttonUsages[name] else { throw HelperError("button must be home, lock, siri, volume_up or volume_down.") }
    guard caps.buttons.contains(name) else { throw HelperError(caps.reasons["buttons"] ?? "That button is not available.") }
    if let hid {
      try hid.button(page: consumerPage, usage: usage, down: true)
      pause(min(10_000, max(50, hold)))
      try hid.button(page: consumerPage, usage: usage, down: false)
      try settle()
    } else {
      // Face ID iPhones have no home button: on the legacy path Home is a quick swipe up from the bottom edge.
      let x = Double(screen.width) / 2
      try straightSwipe(x, Double(screen.height) - 1, x, Double(screen.height) * 0.55, 250, edge: "bottom")
    }
  }

  private func straightSwipe(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, _ ms: Double, edge: String?) throws {
    // One move every 20 ms or more: SimulatorKit drops drags that come less than 16 ms apart.
    let count = max(2, Int(ms / 20))
    let at = { (t: Double, phase: String) -> [String: Any] in
      ["phase": phase, "x": x1 + (x2 - x1) * t, "y": y1 + (y2 - y1) * t, "edge": edge ?? "none"]
    }
    try touch(at(0, "down"))
    for i in 1...count {
      pause(ms / Double(count))
      try touch(at(Double(i) / Double(count), "move"))
    }
    try touch(at(1, "up"))
    try settle()
  }
}

/// SimulatorKit's legacy HID client (Simulator.app 26.5's path for iOS 26 and older).
final class LegacyHID {
  // IndigoHIDMessageForMouseNSEvent(point, second point or nil, target, NSEventType, screen size,
  // edge) -> a touch message (signature read from Xcode 26.5's SimulatorKit). It divides the point
  // by the size, so both are in points. It returns nil for a drag under 16 ms after the previous one.
  private typealias MouseFn = @convention(c) (UnsafeMutablePointer<CGPoint>, UnsafeMutablePointer<CGPoint>?, UInt32, UInt, CGSize, UInt32) -> UnsafeMutableRawPointer?
  private typealias SendFn = @convention(c) (AnyObject, Selector, UnsafeMutableRawPointer, Bool, DispatchQueue?, (@convention(block) (NSError?) -> Void)?) -> Void
  private static let digitizerTarget: UInt32 = 0x32
  private let screen: CGSize
  private var client: NSObject?
  private var send: SendFn?
  private var mouse: MouseFn?
  private let sendSelector = NSSelectorFromString("sendWithMessage:freeWhenDone:completionQueue:completion:")
  private let replies = DispatchQueue(label: "kestrel-sim.replies")
  private(set) var problem: String?
  var ready: Bool { problem == nil }

  init(device: NSObject, screen: CGSize) {
    self.screen = screen
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "IndigoHIDMessageForMouseNSEvent") else { problem = "This Xcode's SimulatorKit has no IndigoHIDMessageForMouseNSEvent."; return }
    guard let cls = NSClassFromString("SimulatorKit.SimDeviceLegacyHIDClient") as? NSObject.Type,
          let allocated = cls.perform(NSSelectorFromString("alloc"))?.takeUnretainedValue() else { problem = "This Xcode has no SimDeviceLegacyHIDClient."; return }
    let (made, error) = callWithError(allocated, "initWithDevice:error:", device)
    guard let made = made as? NSObject else { problem = "Could not open the simulator's input: \(error ?? "no reason given")."; return }
    guard let method = class_getInstanceMethod(object_getClass(made), sendSelector) else { problem = "This Xcode's HID client cannot send messages."; return }
    mouse = unsafeBitCast(symbol, to: MouseFn.self)
    client = made
    send = unsafeBitCast(method_getImplementation(method), to: SendFn.self)
  }

  func touch(_ phase: String, _ point: CGPoint, edge: UInt32) throws {
    guard let mouse, let send, let client else { throw HelperError(problem ?? "Touch input is not available.") }
    let type: NSEvent.EventType
    switch phase {
    case "down": type = .leftMouseDown
    case "up": type = .leftMouseUp
    case "move": type = .leftMouseDragged
    default: throw HelperError("phase must be down, move or up.")
    }
    var p = point
    guard let message = mouse(&p, nil, Self.digitizerTarget, UInt(type.rawValue), screen, edge) else { return }
    let done = DispatchSemaphore(value: 0)
    var failure: String?
    send(client, sendSelector, message, true, replies) { error in
      failure = error?.localizedDescription
      done.signal()
    }
    if done.wait(timeout: .now() + 5) == .timedOut { throw HelperError("The simulator did not take the input within 5 seconds.") }
    if let failure { throw HelperError(failure) }
  }
}

func runInput(_ udid: String) -> Never {
  let device = bootedDevice(udid)
  let input = Input(device: device)
  emit(input.readyLine)
  exitWhenNotBooted(device)
  serveStdin { request in
    let id = request["id"] ?? NSNull()
    do {
      try input.handle(request)
      emit(["id": id, "ok": true])
    } catch let error as HelperError {
      emit(["id": id, "ok": false, "error": error.message])
    } catch {
      emit(["id": id, "ok": false, "error": "\(error)"])
    }
  }
  RunLoop.main.run()
  exit(0)
}
