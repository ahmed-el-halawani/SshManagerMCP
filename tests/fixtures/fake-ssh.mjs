// Fake OpenSSH used by tests. Behaviour is chosen by FAKE_SSH_MODE (inherited env).
// "sh" mode runs the remote command locally with a POSIX sh, so real probe/inspect scripts are exercised.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const cmd = args[args.length - 1];
const mode = process.env.FAKE_SSH_MODE ?? 'sh';
if (process.env.FAKE_SSH_ARGS_FILE) writeFileSync(process.env.FAKE_SSH_ARGS_FILE, JSON.stringify(args));

switch (mode) {
  case 'trust':
    process.stderr.write('No ED25519 host key is known for 10.0.0.5 and you have requested strict checking.\r\nHost key verification failed.\r\n');
    process.exit(255);
  case 'changed':
    process.stderr.write('@@@@@@@@@@@\r\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n');
    process.exit(255);
  case 'auth':
    process.stderr.write('user@10.0.0.5: Permission denied (publickey,password).\r\n');
    process.exit(255);
  case 'dns':
    process.stderr.write('ssh: Could not resolve hostname nope.invalid: No such host is known.\r\n');
    process.exit(255);
  case 'hang':
    setInterval(() => {}, 1000); // never exits: caller must kill the tree
    break;
  case 'flood':
    process.stdout.write('x'.repeat(1 << 20));
    process.exit(0);
  case 'windows': {
    // cmd.exe-like: POSIX command echoes literally, cmd /c ver works
    const m = /echo (__SSHRM_\w+__)/.exec(cmd)?.[1];
    if (cmd.startsWith('cmd /c')) process.stdout.write(`${m}\r\n\r\nMicrosoft Windows [Version 10.0.22631.1]\r\n`);
    else process.stdout.write(`${cmd}\r\n`);
    process.exit(0);
  }
  case 'slow-ok':
    setTimeout(() => { process.stdout.write(`${/echo (__SSHRM_\w+__)/.exec(cmd)?.[1]}\nLinux 6.1\n`); process.exit(0); }, Number(process.env.FAKE_SSH_DELAY ?? 1500));
    break;
  default: {
    const sh = process.env.FAKE_SH ?? 'C:\\Program Files\\Git\\bin\\sh.exe';
    const child = spawn(sh, ['-c', cmd], { stdio: ['pipe', 'inherit', 'inherit'] });
    process.stdin.pipe(child.stdin);
    child.on('close', (code) => process.exit(code ?? 1));
  }
}
