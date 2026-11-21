// `kestrel-sim frames <udid>`: the device's screen as a stream of JPEG pictures.
//
// The picture comes straight from the screen's framebuffer (an IOSurface CoreSimulator shares
// through the device's IO ports), so no process is started per frame. The surface is checked
// `fps` times a second and a picture is sent only when its seed changed (the screen was drawn);
// an idle screen costs one integer read per tick. Pictures are scaled to at most `maxWidth`
// pixels wide and turned upright for the orientation the server says the device is in.
//
// stdout: one record per picture: u32 big-endian JPEG length, u16 width, u16 height, the JPEG.
// stderr: the ready line, {"ready":true,"width":1206,"height":2622} (framebuffer pixels) or
//         {"ready":false,"error":"…"}; later problems as {"error":"…"}.
// `shot` mode writes one JPEG to stdout instead (see runShot).
// stdin:  settings as JSON lines: {"fps":10,"maxWidth":800,"quality":0.7,"orientation":1}, and
//         {"op":"frame"} for a picture now even if nothing changed (a new viewer).
import CoreImage
import Foundation
import IOSurface
import ObjectiveC

final class Frames {
  private let device: NSObject
  private let pixels: CGSize
  private let queue = DispatchQueue(label: "kestrel-sim.frames")
  private let context = CIContext(options: [.cacheIntermediates: false])
  private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
  private var timer: DispatchSourceTimer?
  private var lastSeed: UInt32 = 0
  private var force = true
  private var fps = 10.0
  private var maxWidth = 800.0
  private var quality = 0.7
  private var orientation = 1

  init(device: NSObject) {
    self.device = device
    pixels = screenOf(device).pixels
  }

  /// The IO port descriptor of the main screen: it renders to an IOSurface the size of the device's screen.
  private func screenSurface() -> IOSurface? {
    guard let io = device.value(forKey: "io") as? NSObject, let ports = io.value(forKey: "ioPorts") as? [NSObject] else { return nil }
    for port in ports {
      guard let descriptor = port.perform(NSSelectorFromString("descriptor"))?.takeUnretainedValue() as? NSObject,
            descriptor.responds(to: NSSelectorFromString("framebufferSurface")),
            let surface = descriptor.perform(NSSelectorFromString("framebufferSurface"))?.takeUnretainedValue() as? IOSurface else { continue }
      let size = CGSize(width: surface.width, height: surface.height)
      if size == pixels || size == CGSize(width: pixels.height, height: pixels.width) { return surface }
    }
    return nil
  }

  private var surface: IOSurface?

  func start() {
    guard let found = screenSurface() else { fail("Could not find the simulator's screen. Is it still booting?") }
    surface = found
    emit(["ready": true, "width": found.width, "height": found.height], to: .standardError)
    schedule()
  }

  func configure(_ request: [String: Any]) {
    queue.async { [self] in
      if request["op"] as? String == "frame" { force = true }
      if let v = (request["fps"] as? NSNumber)?.doubleValue, v.isFinite { fps = min(30, max(1, v)) }
      if let v = (request["maxWidth"] as? NSNumber)?.doubleValue, v.isFinite { maxWidth = min(4096, max(100, v)) }
      if let v = (request["quality"] as? NSNumber)?.doubleValue, v.isFinite { quality = min(0.95, max(0.3, v)) }
      if let v = (request["orientation"] as? NSNumber)?.intValue, (1...4).contains(v), v != orientation { orientation = v; force = true }
      if timer != nil, request["fps"] != nil || request["maxWidth"] != nil { force = true; schedule() }
    }
  }

  /// One picture now, whatever changed. For `shot`.
  func shot() -> Data? {
    queue.sync {
      guard let found = screenSurface() else { return nil }
      return encode(found)?.data
    }
  }

  private func schedule() {
    timer?.cancel()
    let t = DispatchSource.makeTimerSource(queue: queue)
    t.schedule(deadline: .now(), repeating: 1.0 / fps, leeway: .milliseconds(5))
    t.setEventHandler { [weak self] in self?.tick() }
    t.resume()
    timer = t
  }

  private func tick() {
    // A rotation or a resize can replace the surface; look again when it stops matching.
    if surface == nil || (surface!.width != Int(pixels.width) && surface!.width != Int(pixels.height)) { surface = screenSurface() }
    guard let surface else { return }
    let seed = surface.seed
    guard force || seed != lastSeed else { return }
    force = false
    lastSeed = seed
    guard let jpeg = encode(surface) else { return }
    var header = Data(count: 8)
    header.withUnsafeMutableBytes { raw in
      raw.storeBytes(of: UInt32(jpeg.data.count).bigEndian, toByteOffset: 0, as: UInt32.self)
      raw.storeBytes(of: UInt16(jpeg.width).bigEndian, toByteOffset: 4, as: UInt16.self)
      raw.storeBytes(of: UInt16(jpeg.height).bigEndian, toByteOffset: 6, as: UInt16.self)
    }
    FileHandle.standardOutput.write(header + jpeg.data)
  }

  /// CGImagePropertyOrientation that turns the portrait framebuffer upright for each device orientation.
  private var upright: CGImagePropertyOrientation {
    switch orientation {
    case 2: return .down
    case 3: return .left
    case 4: return .right
    default: return .up
    }
  }

  private func encode(_ surface: IOSurface) -> (data: Data, width: Int, height: Int)? {
    var image = CIImage(ioSurface: surface)
    // Only rotate when the surface itself is still portrait; some runtimes rotate it for us.
    if surface.width < surface.height { image = image.oriented(upright) }
    let scale = min(1, maxWidth / image.extent.width)
    if scale < 1 { image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale), highQualityDownsample: true) }
    image = image.transformed(by: CGAffineTransform(translationX: -image.extent.origin.x, y: -image.extent.origin.y))
    let options = [CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): quality]
    guard let data = context.jpegRepresentation(of: image, colorSpace: colorSpace, options: options) else { return nil }
    return (data, Int(image.extent.width.rounded()), Int(image.extent.height.rounded()))
  }
}

/// `kestrel-sim shot <udid> <maxWidth> <orientation>`: one JPEG on stdout, then exit. Quicker than
/// `simctl io screenshot`, which starts a process and writes a full-size PNG.
func runShot(_ udid: String, maxWidth: Double, orientation: Int) -> Never {
  let frames = Frames(device: bootedDevice(udid))
  frames.configure(["maxWidth": maxWidth, "orientation": orientation, "quality": 0.85])
  guard let jpeg = frames.shot() else { fail("Could not take a picture of the simulator's screen.") }
  FileHandle.standardOutput.write(jpeg)
  exit(0)
}

func runFrames(_ udid: String) -> Never {
  readyHandle = .standardError
  let device = bootedDevice(udid)
  let frames = Frames(device: device)
  exitWhenNotBooted(device)
  serveStdin { frames.configure($0) }
  frames.start()
  RunLoop.main.run()
  exit(0)
}
