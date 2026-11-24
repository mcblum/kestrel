// The release channel rule (app/release-channel.mjs) for the shell scripts, so every script asks
// the one function instead of comparing versions itself:
//
//   node scripts/release/version.mjs channel <v>                   stable | beta
//   node scripts/release/version.mjs newer <a> <b>                 exit 0 if a is newer than b, else 1 (an empty b is older)
//   node scripts/release/version.mjs feed <v> [platform] [arch]    this version's own feed file (default mac arm64)
//   node scripts/release/version.mjs feeds <v> [liveBeta] [platform] [arch]
//                                                                  every feed file a release of v is written to, one per line
//   node scripts/release/version.mjs due <v> <liveStable> <liveBeta>
//                                                                  exit 0 due, 1 not due; one line saying why
//
// An empty argument ('') means "nothing published". A version that is not 1.2.3 or 1.2.3-beta.4
// exits 2 with the reason.
import { channelOf, feedFileName, feedsFor, isNewer, parseVersion, releaseDue } from '../../app/release-channel.mjs';

const [command, ...args] = process.argv.slice(2);
const orNull = (v) => (v === undefined || v === '' ? null : v);

function run() {
  switch (command) {
    case 'channel':
      console.log(channelOf(args[0]));
      return 0;
    case 'newer':
      parseVersion(args[0]);
      if (orNull(args[1]) !== null) parseVersion(args[1]);
      return isNewer(args[0], orNull(args[1])) ? 0 : 1;
    case 'feed': {
      const [v, platform = 'mac', arch = platform === 'mac' ? 'arm64' : 'x64'] = args;
      console.log(feedFileName(feedsFor(v)[0], platform, arch));
      return 0;
    }
    case 'feeds': {
      const [v, liveBeta, platform = 'mac', arch = platform === 'mac' ? 'arm64' : 'x64'] = args;
      for (const name of feedsFor(v, { liveBeta: orNull(liveBeta) })) console.log(feedFileName(name, platform, arch));
      return 0;
    }
    case 'due': {
      const [v, stable, beta] = args;
      const live = { stable: orNull(stable), beta: orNull(beta) };
      for (const p of [live.stable, live.beta]) if (p !== null) parseVersion(p);
      const { due, against, channel } = releaseDue(v, live);
      const what = channel === 'beta' ? `a beta of ${v}` : `a release of ${v}`;
      if (against === null) console.log(`nothing is published yet: ${what} is due`);
      else if (due) console.log(`the feeds serve ${against}: ${what} is due`);
      else console.log(`the feeds already serve ${against}, and app/package.json says ${v}: no release due (bump the version to cut one)`);
      return due ? 0 : 1;
    }
    default:
      console.error('usage: version.mjs channel|newer|feed|feeds|due … (see the top of this file)');
      return 2;
  }
}

try {
  process.exit(run());
} catch (error) {
  console.error(`!! ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
