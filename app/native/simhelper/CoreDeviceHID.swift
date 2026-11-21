// Input through CoreDevice's HID service inside the simulator (`dtuhidd`), the path Xcode 27's
// DeviceHub uses for simulators, and the only one iOS 27 runtimes take.
//
// How it was found (Xcode 26.5 + the CoreSimulator 1174.20 / CoreDevice 651.28 that Xcode 27.2 beta
// installs in /Library/Developer): CoreSimulator ships an overlay for every iOS runtime with
// /usr/libexec/dtuhidd, whose launchd plist vends com.apple.coredevice.feature.remote.hid.{digitizer,
// keyboard,button,...}. CoreDevice's SimulatorCoreDevicePlugin reaches them with
// `-[SimDevice lookup:error:]`, `xpc_endpoint_create_mach_port_4sim` and
// `xpc_connection_enable_sim2host_4sim`. dtuhidd's "IndigoHIDServer" reads XPC dictionaries
// {messageType, payload} (field names from CoreDeviceUtilities' HIDXPCServiceEvent) and decodes the
// payload with Codable; its decoding errors, read from the simulator's log, gave the payload keys.
// Observed working on iOS 26.5 (23F77) and iOS 27.2 (24B5110a) simulators:
//   IndigoDigitizerEvent  {pointOne:{x,y}, pointTwo?:{x,y}, eventType: 0 down | 1 move | 2 up,
//                          edge: 0 none | 1 top | 2 left | 3 bottom, target: 0 (main screen)}
//                          points are 0…1 of the portrait screen; pointTwo is a second finger.
//   IndigoKeyboardButtonEvent {usageCode: HID keyboard usage, state: 1 down | 2 up}
//   IndigoButtonEvent     {usagePage, usageCode, state: 1 down | 2 up}  (consumer page 0x0C:
//                          0x40 Home, 0x30 Lock/side, 0xCF Siri, 0xE9 volume up, 0xEA volume down)
//   {isBarrier: true}     answered once every earlier message was handled.
// A message dtuhidd cannot decode ends the connection; it is opened again on the next request.
// dtuhidd creates its virtual touchscreen, keyboard and buttons per connection, so everything goes
// through ONE connection: a second one would add a second touchscreen that backboardd ignores.
import Foundation
import XPC

private typealias EndpointFn = @convention(c) (mach_port_t) -> xpc_endpoint_t?
private typealias EnableFn = @convention(c) (xpc_connection_t) -> Void

private let digitizerService = "com.apple.coredevice.feature.remote.hid.digitizer"

final class CoreDeviceHID {
  private let device: NSObject
  private let makeEndpoint: EndpointFn
  private let enableSim2Host: EnableFn
  private var connection: xpc_connection_t?
  private let lock = NSLock()

  /// Nil with the reason when this Mac's CoreSimulator has no such path for the device.
  static func open(_ device: NSObject) -> (CoreDeviceHID?, String?) {
    let any = UnsafeMutableRawPointer(bitPattern: -2)
    guard let endpoint = dlsym(any, "xpc_endpoint_create_mach_port_4sim"), let enable = dlsym(any, "xpc_connection_enable_sim2host_4sim") else {
      return (nil, "this macOS has no simulator XPC bridge")
    }
    let (port, error) = lookupPort(device, digitizerService)
    guard port != nil else { return (nil, "the simulator has no CoreDevice HID service (\(error ?? "not found")); it needs the CoreSimulator that Xcode 27 installs") }
    return (CoreDeviceHID(device, unsafeBitCast(endpoint, to: EndpointFn.self), unsafeBitCast(enable, to: EnableFn.self)), nil)
  }

  private init(_ device: NSObject, _ makeEndpoint: EndpointFn, _ enableSim2Host: EnableFn) {
    self.device = device
    self.makeEndpoint = makeEndpoint
    self.enableSim2Host = enableSim2Host
  }

  /// The connection, opened if needed. dtuhidd exits when idle (EnablePressuredExit); a lookup starts it again.
  private func connected() throws -> xpc_connection_t {
    lock.lock()
    defer { lock.unlock() }
    if let connection { return connection }
    let (port, error) = lookupPort(device, digitizerService)
    guard let port, let endpoint = makeEndpoint(port) else { throw HelperError("The simulator's input service is not available: \(error ?? "no endpoint").") }
    let made = xpc_connection_create_from_endpoint(endpoint)
    enableSim2Host(made)
    xpc_connection_set_event_handler(made) { [weak self] event in
      // Any error (interrupted, invalid) means start over with a new connection next time.
      if xpc_get_type(event) == XPC_TYPE_ERROR { self?.drop(made) }
    }
    xpc_connection_resume(made)
    connection = made
    return made
  }

  private func drop(_ which: xpc_connection_t) {
    lock.lock()
    defer { lock.unlock() }
    if let connection, connection === which { xpc_connection_cancel(connection); self.connection = nil }
  }

  private func send(_ type: String, _ payload: xpc_object_t) throws {
    let message = xpc_dictionary_create(nil, nil, 0)
    xpc_dictionary_set_string(message, "messageType", type)
    xpc_dictionary_set_value(message, "payload", payload)
    xpc_connection_send_message(try connected(), message)
  }

  /// Waits until dtuhidd has handled everything sent so far; throws if it dropped the connection.
  func barrier() throws {
    let connection = try connected()
    let message = xpc_dictionary_create(nil, nil, 0)
    xpc_dictionary_set_bool(message, "isBarrier", true)
    let done = DispatchSemaphore(value: 0)
    var failed: String?
    xpc_connection_send_message_with_reply(connection, message, DispatchQueue.global()) { reply in
      if xpc_get_type(reply) == XPC_TYPE_ERROR {
        failed = xpc_dictionary_get_string(reply, XPC_ERROR_KEY_DESCRIPTION).map { String(cString: $0) } ?? "connection lost"
      }
      done.signal()
    }
    if done.wait(timeout: .now() + 5) == .timedOut { throw HelperError("The simulator's input service did not answer within 5 seconds.") }
    if let failed {
      drop(connection)
      throw HelperError("The simulator's input service refused the input (\(failed)).")
    }
  }

  // MARK: - events

  enum Phase: UInt64 { case down = 0, move = 1, up = 2 }

  /// One digitizer report: one or two fingers, in portrait points of a screen `size` points big.
  func touch(_ phase: Phase, _ one: CGPoint, _ two: CGPoint?, edge: UInt64, size: CGSize) throws {
    let payload = xpc_dictionary_create(nil, nil, 0)
    xpc_dictionary_set_value(payload, "pointOne", unit(one, size))
    if let two { xpc_dictionary_set_value(payload, "pointTwo", unit(two, size)) }
    xpc_dictionary_set_uint64(payload, "eventType", phase.rawValue)
    xpc_dictionary_set_uint64(payload, "edge", edge)
    xpc_dictionary_set_uint64(payload, "target", 0)
    try send("IndigoDigitizerEvent", payload)
  }

  func key(usage: UInt64, down: Bool) throws {
    let payload = xpc_dictionary_create(nil, nil, 0)
    xpc_dictionary_set_uint64(payload, "usageCode", usage)
    xpc_dictionary_set_uint64(payload, "state", down ? 1 : 2)
    try send("IndigoKeyboardButtonEvent", payload)
  }

  func button(page: UInt64, usage: UInt64, down: Bool) throws {
    let payload = xpc_dictionary_create(nil, nil, 0)
    xpc_dictionary_set_uint64(payload, "usagePage", page)
    xpc_dictionary_set_uint64(payload, "usageCode", usage)
    xpc_dictionary_set_uint64(payload, "state", down ? 1 : 2)
    try send("IndigoButtonEvent", payload)
  }

  private func unit(_ p: CGPoint, _ size: CGSize) -> xpc_object_t {
    let point = xpc_dictionary_create(nil, nil, 0)
    xpc_dictionary_set_double(point, "x", min(1, max(0, Double(p.x / size.width))))
    xpc_dictionary_set_double(point, "y", min(1, max(0, Double(p.y / size.height))))
    return point
  }
}
