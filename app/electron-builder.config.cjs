// electron-builder configuration for Kestrel: Kestrel.app (arm64, Developer ID, hardened runtime),
// the Windows installer (NSIS, x64) and the Linux AppImage.
// It packages what app/scripts/package/stage.mjs laid out in dist/stage, which is staged for one
// platform at a time: make-release.sh runs both for the Mac, make-release-desktop.sh for the others.
// Signing identity and notary profile come from the environment (names only, never secrets):
//   KESTREL_SIGN_ID         default "Developer ID Application: Matthew Blum (NLJAPE8842)"
//   KESTREL_NOTARY_PROFILE  default "Vireo" (a notarytool keychain profile)
//   KESTREL_SKIP_NOTARIZE=1 sign only (local iterations)
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const stage = join(root, 'dist', 'stage');
const DEFAULT_SIGN_ID = 'Developer ID Application: Matthew Blum (NLJAPE8842)';
const signId = process.env.KESTREL_SIGN_ID || DEFAULT_SIGN_ID;
const icon = join(root, 'Brand', 'exports', 'icon.icns');
// Windows and Linux take a PNG: electron-builder makes the .ico and the icon sizes from it.
const pngIcon = join(root, 'Brand', 'exports', 'icon-512.png');
const entitlements = join(__dirname, 'build', 'entitlements.mac.plist');
// The Electron already in node_modules is this computer's. It is used when the build is for this
// computer's platform; a build for another one (a Windows installer made on Linux) downloads its own.
const localElectron = join(root, 'app', 'node_modules', 'electron', 'dist');
const target = process.env.KESTREL_TARGET_PLATFORM || process.platform;
const useLocalElectron = target === process.platform && existsSync(localElectron);

module.exports = {
  appId: 'io.nationalmachine.kestrel',
  productName: 'Kestrel',
  executableName: 'Kestrel',
  copyright: '© 2026 Matt Blum',
  electronVersion: '45.3.2',
  ...(useLocalElectron ? { electronDist: localElectron } : {}),
  directories: { app: join(stage, 'app'), output: join(root, 'dist', 'builder'), buildResources: join(__dirname, 'build') },
  files: ['**/*'],
  asar: true,
  // The staged app has no node_modules; node-pty is N-API and prebuilt, so nothing is rebuilt for Electron.
  npmRebuild: false,
  nodeGypRebuild: false,
  extraResources: [
    // Its node_modules (node-pty) is copied in by after-pack.cjs: electron-builder skips node_modules here.
    { from: join(stage, 'resources', 'server'), to: 'server' },
    { from: join(stage, 'resources', 'bin'), to: 'bin' },
  ],
  mac: {
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ],
    artifactName: 'Kestrel-${version}-${arch}-mac.${ext}',
    category: 'public.app-category.developer-tools',
    icon,
    // Electron 45 needs macOS 12 Monterey or later.
    minimumSystemVersion: '12.0',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements,
    entitlementsInherit: entitlements,
    // electron-builder wants the identity without its certificate-type prefix.
    identity: signId.replace(/^Developer ID Application:\s*/, ''),
    // Anthropic's own Developer ID signature (with the entitlements Bun needs) stays on the Claude binary.
    signIgnore: ['/Contents/Resources/bin/claude$'],
    notarize: false,
    extendInfo: {
      LSApplicationCategoryType: 'public.app-category.developer-tools',
      NSHumanReadableCopyright: '© 2026 Matt Blum',
      // Folders may be dropped on the Dock icon (main.mjs, open-file: Create project with them).
      // Alternate: Kestrel is offered for folders but never becomes their default app.
      CFBundleDocumentTypes: [{ CFBundleTypeName: 'Folder', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['public.folder'] }],
    },
  },
  dmg: {
    artifactName: 'Kestrel-${version}-${arch}.${ext}',
    title: 'Kestrel',
    icon,
    // make-release.sh signs, notarizes and staples the DMG after electron-builder made it.
    sign: false,
    writeUpdateInfo: false,
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: pngIcon,
    // Not code-signed: there is no Windows certificate yet, so SmartScreen warns on first run.
    // KESTREL_WIN_NO_EDIT=1 also skips writing the icon and version into Kestrel.exe, which off
    // Windows needs wine (a packaging check on a Mac; never a release).
    ...(process.env.KESTREL_WIN_NO_EDIT === '1' ? { signAndEditExecutable: false } : {}),
  },
  nsis: {
    // One click, for this user only: no administrator prompt, and updates install the same way.
    oneClick: true,
    perMachine: false,
    artifactName: 'Kestrel-Setup-${version}-${arch}.${ext}',
    shortcutName: 'Kestrel',
    uninstallDisplayName: 'Kestrel',
  },
  linux: {
    // An AppImage runs on any distribution and is the form electron-updater can replace in place.
    target: [{ target: 'AppImage' }],
    icon: pngIcon,
    category: 'Development',
    synopsis: 'Runs coding agents, organized around tasks.',
    artifactName: 'Kestrel-${version}-${arch}.${ext}',
    executableName: 'kestrel',
  },
  afterPack: join(root, 'scripts', 'release', 'after-pack.cjs'),
  // Notarize and staple the app before the DMG and zip are made from it, so both carry the ticket.
  afterSign: join(root, 'scripts', 'release', 'after-sign.cjs'),
  // Writes app-update.yml into the app and the blockmaps; the feeds themselves (latest-mac.yml,
  // latest.yml, latest-linux.yml) are written by write-feed.mjs. The app sets its feed URL itself
  // (app/updater.mjs).
  publish: { provider: 'generic', url: 'https://starfish.nationalmachine.io/kestrel/releases/-/raw/main/' },
};
