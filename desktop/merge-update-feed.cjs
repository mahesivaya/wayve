// Combine each arch's latest-mac.yml into one. A build of a single prepackaged
// arch writes a feed listing only that arch, and the updater picks its own from
// the one file it reads.
//   node merge-update-feed.cjs <arm64.yml> <x64.yml> > latest-mac.yml
const fs = require("fs");
const yaml = require("js-yaml");

function mergeFeeds(feeds) {
  const versions = new Set(feeds.map((feed) => feed.version));
  if (versions.size !== 1) {
    throw new Error(`Feeds disagree on version: ${[...versions].join(", ")}`);
  }
  return { ...feeds[0], files: feeds.flatMap((feed) => feed.files) };
}

const paths = process.argv.slice(2);
if (paths.length < 2) {
  console.error("Usage: merge-update-feed.cjs <feed.yml> <feed.yml> [...]");
  process.exit(1);
}
const feeds = paths.map((p) => yaml.load(fs.readFileSync(p, "utf8")));
process.stdout.write(yaml.dump(mergeFeeds(feeds), { lineWidth: -1 }));
