'use strict';

const ModuleResolver = require('internal/modules/cjs/resolver');
const { NativeModule } = require('internal/bootstrap/loaders');
const { extname } = require('path');
const StringStartsWith = Function.call.bind(String.prototype.startsWith);
const { fileURLToPath, pathToFileURL } = require('internal/url');

function search(target, base) {
  const filename = moduleResolver.resolve(target, fileURLToPath(base));
  return pathToFileURL(filename);
}

const extensionFormatMap = {
  '__proto__': null,
  '.mjs': 'esm',
  '.js': 'esm',
};

const moduleResolver = new ModuleResolver({
  extensions: Object.keys(extensionFormatMap),
  useGlobalPaths: false,
  packageMainKeys: ['module'],
});

function toPath(s) {
  if (!s) return null;
  if (StringStartsWith(s, 'file:')) return fileURLToPath(s);
  return decodeURIComponent(s);
}

function resolve(specifier, parentURL) {
  if (NativeModule.canBeRequiredByUsers(specifier)) {
    return {
      url: specifier,
      format: 'builtin'
    };
  }

  const filename = moduleResolver.resolve(
    toPath(specifier),
    toPath(parentURL),
    { isMain: !parentURL });

  const format = extensionFormatMap[extname(filename)];

  return {
    url: `${pathToFileURL(filename)}`,
    format
  };
}

module.exports = resolve;
// exported for tests
module.exports.search = search;
