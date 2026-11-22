// electron-builder's afterPack hook, before signing. On every platform:
//  - The Electron copied in carries Electron's own sample app (default_app.asar, "Electron" all
//    over it); Kestrel never loads it, so it is removed.
//  - electron-builder leaves every node_modules folder out of extraResources, whatever the
//    filter says, so the server's one native dependency (node-pty) is copied in here, beside
//    the server bundle, where Node's resolution finds it.
// On a Mac only: electron-builder renames the helper apps ("Kestrel Helper (Renderer)") but leaves
// their CFBundleName as "Electron Helper …"; it is set to match.
const { execFileSync } = require('node:child_process');
const { cpSync, existsSync, readdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');

const STAGED_MODULES = join(__dirname, '..', '..', 'dist', 'stage', 'resources', 'server', 'node_modules');

/** Where the packed app keeps its resources: inside the bundle on a Mac, beside the program elsewhere. */
function resourcesDir(context) {
  if (context.electronPlatformName === 'darwin') return join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  return join(context.appOutDir, 'resources');
}

module.exports = async function afterPack(context) {
  const resources = resourcesDir(context);
  rmSync(join(resources, 'default_app.asar'), { force: true });
  if (context.electronPlatformName === 'darwin') {
    const frameworks = join(resources, '..', 'Frameworks');
    for (const helper of readdirSync(frameworks).filter((name) => name.endsWith('.app'))) {
      const plist = join(frameworks, helper, 'Contents', 'Info.plist');
      execFileSync('plutil', ['-replace', 'CFBundleName', '-string', helper.replace(/\.app$/, ''), plist]);
    }
  }
  if (!existsSync(join(STAGED_MODULES, 'node-pty', 'package.json'))) throw new Error(`node-pty is not staged in ${STAGED_MODULES}`);
  cpSync(STAGED_MODULES, join(resources, 'server', 'node_modules'), { recursive: true, verbatimSymlinks: false });
};

module.exports.resourcesDir = resourcesDir;
