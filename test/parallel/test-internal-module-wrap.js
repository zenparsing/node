'use strict';

// Flags: --expose-internals

require('../common');
const assert = require('assert');

const { internalBinding } = require('internal/test/binding');
const { ModuleWrap } = internalBinding('module_wrap');

const foo = new ModuleWrap('export * from "bar"; 6;', 'foo');
const bar = new ModuleWrap('export const five = 5', 'bar');

(async () => {
  const deps = foo.getDependencySpecifiers();
  assert.deepStrictEqual(deps, ['bar']);
  foo.resolveDependency('bar', bar);
  foo.instantiate();
  assert.strictEqual(foo.evaluate(-1, false), 6);
  assert.strictEqual(foo.getNamespace().five, 5);
})();
