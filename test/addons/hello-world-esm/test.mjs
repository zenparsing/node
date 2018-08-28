/* eslint-disable node-core/required-modules */

import assert from 'assert';
// ES loader does not currently support addons
const binding = import.meta.require('./build/binding.node');
assert.strictEqual(binding.hello(), 'world');
console.log('binding.hello() =', binding.hello());
