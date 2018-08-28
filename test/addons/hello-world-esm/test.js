'use strict';
const common = require('../../common');

const assert = require('assert');
const { spawnSync } = require('child_process');
const { copyFileSync } = require('fs');
const { join } = require('path');

const buildDir = join(__dirname, 'build');

copyFileSync(join(buildDir, common.buildType, 'binding.node'),
             join(buildDir, 'binding.node'));

const result = spawnSync(process.execPath,
                         ['--module', `${__dirname}/test.mjs`]);

assert.ifError(result.error);
assert.strictEqual(result.stderr.toString().trim(), '');
assert.strictEqual(result.stdout.toString().trim(), 'binding.hello() = world');
