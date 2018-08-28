import '../common';
import assert from 'assert';

const calls = [];

// No-op plugin
process.addModuleLoaderPlugin({
  id: 1,
  async resolve(specifier, url) {
    const { id } = this;
    calls.push({ id, type: 'resolve', specifier, url });
  },
  async load(url) {
    const { id } = this;
    calls.push({ id, type: 'load', url });
  },
  async translate(source, url) {
    const { id } = this;
    calls.push({ id, type: 'translate', source, url });
  }
});

// Full plugin
process.addModuleLoaderPlugin({
  id: 2,
  async resolve(specifier, url) {
    const { id } = this;
    calls.push({ id, type: 'resolve', specifier, url });
    return 'file:///test.js';
  },
  async load(url) {
    const { id } = this;
    calls.push({ id, type: 'load', url });
    return {
      source: '#!foobar\nexport const x = 42;'
    };
  },
  async translate(source, url) {
    const { id } = this;
    calls.push({ id, type: 'translate', source, url });
    return source.replace(/42/, '43');
  }
});

// Translate-only plugin
process.addModuleLoaderPlugin({
  id: 3,
  async resolve(specifier, url) {
    assert.fail('Resolve should not be called after successful resolve');
  },
  async load(url) {
    assert.fail('Load should not be called after successful load');
  },
  async translate(source, url) {
    const { id } = this;
    calls.push({ id, type: 'translate', source, url });
    return source.replace(/43/, '44');
  }
});

import('foo').then((ns) => {
  assert.strictEqual(ns.x, 44);
  assert.deepStrictEqual(calls, [
    {
      id: 1,
      type: 'resolve',
      specifier: 'foo',
      url: import.meta.url
    },
    {
      id: 2,
      type: 'resolve',
      specifier: 'foo',
      url: import.meta.url
    },
    {
      id: 1,
      type: 'load',
      url: 'file:///test.js'
    },
    {
      id: 2,
      type: 'load',
      url: 'file:///test.js'
    },
    {
      id: 1,
      type: 'translate',
      source: '\nexport const x = 42;',
      url: 'file:///test.js'
    },
    {
      id: 2,
      type: 'translate',
      source: '\nexport const x = 42;',
      url: 'file:///test.js'
    },
    {
      id: 3,
      type: 'translate',
      source: '\nexport const x = 43;',
      url: 'file:///test.js'
    }
  ]);
});
