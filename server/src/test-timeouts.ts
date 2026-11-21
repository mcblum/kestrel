// How long a test may run. Vitest's default (5 s) stays for everything else; a test file that builds
// real git repositories sets this one at its top:
//
//   vi.setConfig({ testTimeout: GIT_TEST_TIMEOUT_MS });
//
// Such a test spawns tens of git processes and takes 1 to 8 s on a quiet machine. Under load (a full
// run beside another one) git process start-up slows several-fold, and those tests timed out at 5 s,
// and once at 20 s, while passing alone. 30 s leaves room for that and still fails a hung test in
// half a minute, not minutes.
export const GIT_TEST_TIMEOUT_MS = 30_000;
