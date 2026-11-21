// Builds the Kestrel server to one JavaScript file for the packaged app, so no TypeScript (and no
// tsx) runs at runtime. Everything is bundled except node-pty, a native module that is shipped as
// a real node_modules folder beside the bundle (stage.mjs copies it).
import { build } from 'esbuild';

/** Kept out of the bundle: node-pty loads its prebuilt .node file and spawn-helper from its own folder;
 *  bufferutil and utf-8-validate are optional speed-ups of `ws` that are not installed. */
export const SERVER_EXTERNALS = ['node-pty', 'bufferutil', 'utf-8-validate'];

// Bundled CommonJS packages call require() for Node's built-ins; an ES module has no require.
const REQUIRE_SHIM = "import { createRequire as __kestrelCreateRequire } from 'node:module'; const require = __kestrelCreateRequire(import.meta.url);";

export async function buildServer({ entry, outfile }) {
  const result = await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: SERVER_EXTERNALS,
    banner: { js: REQUIRE_SHIM },
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    metafile: true,
  });
  return result;
}
