// --- Install Version Check ---
// "version" in app.config.js is the INSTALL number: it changes exactly when phones need a fresh install, and stays
// the same for updates that arrive over the air. Expo's update "runtime" (a fingerprint of everything native) is
// what decides which phones receive an update, and `version` is part of that fingerprint — so a phone on an older
// install never gets updates published for a newer one. install-versions.json records the runtime each version was
// built with. This compares it to the runtime the code would publish to now, and fails if they differ: native code
// or config changed without a version bump, so an update published now would silently miss phones on this version.
//
//   node scripts/check-install-version.js            before every `eas update`
//   node scripts/check-install-version.js --record   after bumping the version, before `eas build`
//
// Run it as a plain node command — adding an npm script would itself change the runtime.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const tablePath = path.join(root, 'install-versions.json');
const table = JSON.parse(fs.readFileSync(tablePath, 'utf8'));
const { version } = require(path.join(root, 'app.config.js')).expo;

const output = execSync('npx expo-updates fingerprint:generate --platform android', { cwd: root, encoding: 'utf8' });
const runtime = JSON.parse(output.slice(output.indexOf('{'))).hash;
const short = runtime.slice(0, 8);
const recorded = table[version];

if (process.argv.includes('--record')) {
  if (recorded && recorded !== runtime) {
    console.error(`Install ${version} is already recorded with runtime ${recorded.slice(0, 8)}, but the code is now ${short}. Bump "version" in app.config.js first.`);
    process.exit(1);
  }
  table[version] = runtime;
  fs.writeFileSync(tablePath, `${JSON.stringify(table, null, 2)}\n`);
  console.log(`Recorded: install ${version} = runtime ${short}. Now run eas build.`);
} else if (recorded === runtime) {
  console.log(`OK: install ${version} (runtime ${short}) — an update published now reaches phones on ${version}.`);
} else if (!recorded) {
  console.error(`Install ${version} hasn't been recorded. Run with --record, then eas build.`);
  process.exit(1);
} else {
  console.error(
    `STOP: the runtime changed since install ${version} was built (was ${recorded.slice(0, 8)}, now ${short}). ` +
      `Phones on ${version} would NOT receive an update published now. Bump "version" in app.config.js, run this with --record, then eas build.`
  );
  process.exit(1);
}
