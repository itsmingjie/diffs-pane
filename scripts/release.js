import { spawnSync } from 'node:child_process';

const requestedBump = process.argv[2];
const validBump =
  /^(?:major|minor|patch|premajor|preminor|prepatch|prerelease|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

if (requestedBump !== undefined && !validBump.test(requestedBump)) {
  fail(`invalid release version: ${requestedBump}`);
}

const branch = capture('git', ['branch', '--show-current']);
if (branch !== 'main') {
  fail(`releases must run from main (current branch: ${branch || 'detached HEAD'})`);
}

if (capture('git', ['status', '--porcelain']) !== '') {
  fail('working tree must be clean before releasing');
}

run('git', ['fetch', '--tags', 'origin', 'main']);
const localHead = capture('git', ['rev-parse', 'HEAD']);
const remoteHead = capture('git', ['rev-parse', 'origin/main']);
if (localHead !== remoteHead) {
  fail('local main must exactly match origin/main before releasing');
}

let version = packageVersion();
let tag = `v${version}`;
const shouldBump = requestedBump !== undefined || remoteTagExists(tag);

if (shouldBump) {
  run(pnpmCommand(), ['version', requestedBump ?? 'patch', '--no-git-tag-version']);
  version = packageVersion();
  tag = `v${version}`;
  if (remoteTagExists(tag) || localTagExists(tag)) fail(`tag ${tag} already exists`);

  run('git', ['add', 'package.json', 'pnpm-lock.yaml']);
  run('git', ['commit', '-m', `Release ${tag}`]);
}

if (localTagExists(tag)) {
  const tagCommit = capture('git', ['rev-list', '-n', '1', tag]);
  if (tagCommit !== capture('git', ['rev-parse', 'HEAD'])) {
    fail(`local tag ${tag} does not point to HEAD`);
  }
} else {
  run('git', ['tag', '--annotate', tag, '--message', `Release ${tag}`]);
}

run('git', ['push', '--atomic', 'origin', 'main', `refs/tags/${tag}`]);
process.stdout.write(`${tag} pushed. GitHub Actions will publish it.\n`);

function packageVersion() {
  return capture(process.execPath, ['-p', "require('./package.json').version"]);
}

function localTagExists(tagName) {
  return succeeds('git', ['rev-parse', '--quiet', '--verify', `refs/tags/${tagName}`]);
}

function remoteTagExists(tagName) {
  return succeeds('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tagName}`]);
}

function succeeds(command, args) {
  return spawnSync(command, args, { stdio: 'ignore' }).status === 0;
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    fail(`${command} ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed`);
}

function pnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function fail(message) {
  process.stderr.write(`Release aborted: ${message}\n`);
  process.exit(1);
}
