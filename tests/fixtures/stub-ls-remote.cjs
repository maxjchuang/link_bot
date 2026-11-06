const childProcess = require('node:child_process');
const original = childProcess.execFileSync;
childProcess.execFileSync = (file, args, options) => {
  if (file === '/usr/bin/git' && args.includes('ls-remote')) return `${process.env.TEST_GIT_SHA}\trefs/heads/main\n`;
  return original(file, args, options);
};
