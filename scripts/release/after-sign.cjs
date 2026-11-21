// electron-builder's afterSign hook: notarize and staple Kestrel.app (notarize.sh) before the DMG
// and the update zip are made from it. Skipped with KESTREL_SKIP_NOTARIZE=1.
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  if (process.env.KESTREL_SKIP_NOTARIZE === '1') {
    console.log(`  • skipping notarization of ${app} (KESTREL_SKIP_NOTARIZE=1)`);
    return;
  }
  execFileSync(join(__dirname, 'notarize.sh'), [app], { stdio: 'inherit' });
};
