'use strict';
const path = require('path');
const through2 = require('through2');
const dargs = require('dargs');
const gutil = require('gulp-util');
const groupBy = require('lodash.groupby');
const PQueue = require('p-queue');
const commandRunner = require('./lib/command-runner');

const commands = {
  tsd: ['reinstall', '--save'],
  bower: ['install', '--config.interactive=false'],
  npm: ['install'],
  pip: ['install', '-r', 'requirements.txt'],
  composer: ['install'],
  typings: ['install']
};

const defaultFileToCommand = {
  'tsd.json': 'tsd',
  'bower.json': 'bower',
  'package.json': 'npm',
  'requirements.txt': 'pip',
  'composer.json': 'composer',
  'typings.json': 'typings'
};

const noop = () => {};

module.exports = function (opts = {}, done = noop) {
  if (typeof opts === 'function') {
    done = opts;
    opts = {};
  }
  const fileToCommand = Object.assign(
    {},
    defaultFileToCommand,
    opts.commands
  );
  const toRun = [];

  return through2(
    {objectMode: true},
    function (file, enc, cb) {
      if (!file.path) {
        return cb();
      }

      if (opts.compare) {
        var cdir = path.join(__dirname, '/compares/', path.dirname(file.path));
        var cfile = path.join(cdir, path.basename(file.path));
        try {
          require(cfile);
        } catch (e) {
          if (!fs.existsSync(cdir)) {
            cdir.split(path.sep).reduce((curPath, folder) => {
              curPath += folder + path.sep;
              if (!fs.existsSync(curPath)) fs.mkdirSync(curPath);
              return curPath;
            }, '');
          };
          if (e.code === 'MODULE_NOT_FOUND') fs.writeFileSync(cfile, JSON.stringify({}));
        }
        let moduleJSON = JSON.stringify(require(file.path), null, '  ');
        if (JSON.stringify(require(cfile), null, '  ') !== moduleJSON) {
          fs.writeFileSync(cfile, moduleJSON);
        } else {
          return cb();
        }
      }

      if (fileToCommand[path.basename(file.path)]) {
        const cmd = {
          cmd: fileToCommand[path.basename(file.path)],
          args: (commands[fileToCommand[path.basename(file.path)]] || []).slice()
        };

        if (['bower', 'npm'].includes(cmd.cmd) && opts.production) {
          cmd.args.push('--production');
        }
        if (cmd.cmd === 'npm' && opts.ignoreScripts) {
          cmd.args.push('--ignore-scripts');
        }
        if (opts.args) {
          cmd.args = cmd.args.concat(opts.args).map(arg => arg.toString());
        }
        if (Array.isArray(opts[cmd.cmd])) {
          cmd.args = cmd.args.concat(opts[cmd.cmd].map(arg => arg.toString()));
        } else if (typeof opts[cmd.cmd] === 'object') {
          cmd.args = cmd.args.concat(dargs(opts[cmd.cmd]));
        } else if (opts[cmd.cmd]) {
          cmd.args = cmd.args.concat(opts[cmd.cmd].toString());
        }
        if (cmd.cmd === 'bower' && opts.allowRoot) {
          cmd.args.push('--allow-root');
        }
        if (cmd.cmd === 'npm' && opts.noOptional) {
          cmd.args.push('--no-optional');
        }

        cmd.cwd = path.dirname(file.path);
        toRun.push(cmd);
      }
      this.push(file);
      cb();
    },
    cb => {
      if (toRun.length === 0) {
        return cb();
      }
      if (skipInstall()) {
        log('Skipping install.', 'Run `' + gutil.colors.yellow(formatCommands(toRun)) + '` manually');
        return cb();
      }
      const groupedCommands = groupBy(toRun, 'cmd');
      Promise.all(Object.keys(groupedCommands).map(cmd => {
        const commands = groupedCommands[cmd];
        const queue = new PQueue({concurrency: 1});
        return Promise.all(commands.map(command => queue.add(() => logFailure(command)(commandRunner.run(command)))));
      }))
      .then(() => done())
      .then(() => cb(), cb); // eslint-disable-line promise/no-callback-in-promise
    }
  );
};

function logFailure(command) {
  return promise => {
    return promise.catch(err => {
      log(err.message, ', run `' + gutil.colors.yellow(formatCommand(command)) + '` manually');
      throw err;
    });
  };
}

function log(...args) {
  if (isTest()) {
    return;
  }
  gutil.log(...args);
}

function formatCommands(cmds) {
  return cmds.map(formatCommand).join(' && ');
}

function formatCommand(command) {
  return command.cmd + ' ' + command.args.join(' ');
}

function skipInstall() {
  return process.argv.slice(2).includes('--skip-install');
}

function isTest() {
  return process.env.NODE_ENV === 'test';
}
