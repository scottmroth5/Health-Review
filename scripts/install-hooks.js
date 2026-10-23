// npm install (prepare): points git at .githooks so the pre-commit personal-data check runs. Does nothing outside a git
// checkout (a container build, a package install), so it never fails an install.
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { repoPath } from '../tools/paths.js';

if (existsSync(repoPath('.git'))) {
  try {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: repoPath(), stdio: 'ignore' });
  } catch {
    // git missing: nothing to install
  }
}
