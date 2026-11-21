// electron-builder's afterPack hook, before signing.
//  - The Electron copied from node_modules carries Electron's own sample app (default_app.asar,
//    "Electron" all over it); Kestrel never loads it, so it is removed.
//  - electron-builder renames the helper apps ("Kestrel Helper (Renderer)") but leaves their
//    CFBundleName as "Electron Helper …"; it is set to match.
//  - electron-builder leaves every node_modules folder out of extraResources, whatever the
//    filter says, so the server's one native dependency (node-pty) is copied in here, beside
//    the server bundle, where Node's resolution finds it.
const { execFileSync } = require('node:child_process');
const { cpSync, existsSync, readdirSync, rmSync } = require('node:fs');
const { join } = require('node:path');

const STAGED_MODULES = join(__dirname, '..', '..', 'dist', 'stage', 'resources', 'server', 'node_modules');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const resources = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  rmSync(join(resources, 'default_app.asar'), { force: true });
  const frameworks = join(resources, '..', 'Frameworks');
  for (const helper of readdirSync(frameworks).filter((name) => name.endsWith('.app'))) {
    const plist = join(frameworks, helper, 'Contents', 'Info.plist');
    execFileSync('plutil', ['-replace', 'CFBundleName', '-string', helper.replace(/\.app$/, ''), plist]);
  }
  if (!existsSync(join(STAGED_MODULES, 'node-pty', 'package.json'))) throw new Error(`node-pty is not staged in ${STAGED_MODULES}`);
  cpSync(STAGED_MODULES, join(resources, 'server', 'node_modules'), { recursive: true, verbatimSymlinks: false });
};
