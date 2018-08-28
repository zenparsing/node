'use strict';

const ModuleLoader = require('internal/modules/esm/module_loader');

const {
  makeRequireFunction,
  stripShebang
} = require('internal/modules/cjs/helpers');

const {
  fileURLToPath,
  pathToFileURL
} = require('internal/url');

const { NativeModule } = require('internal/bootstrap/loaders');
const ModuleResolver = require('internal/modules/cjs/resolver');
const fs = require('fs');
const { dirname } = require('path');
const { promisify } = require('util');

const readFileAsync = promisify(fs.readFile);
const StringStartsWith = Function.call.bind(String.prototype.startsWith);
const EXTENSIONS = ['.mjs', '.js'];

function isFileURL(s) {
  return StringStartsWith(s, 'file:');
}

function isBuiltinURL(s) {
  return StringStartsWith(s, 'node:');
}

function toPath(s) {
  if (!s) return null;
  else if (isFileURL(s)) return fileURLToPath(s);
  else return decodeURIComponent(s);
}

function createRequire(filename) {
  // Lazy load CJS loader in order to avoid circular
  // dependencies between ESM and CJS loaders
  const CJSModule = require('internal/modules/cjs/loader');
  const m = new CJSModule(filename);
  m.filename = filename;
  m.paths = CJSModule._nodeModulePaths(dirname(filename));
  return makeRequireFunction(m);
}

async function loadNativeModule(id) {
  const nativeModule = NativeModule.require(id);
  const keys = Object.keys(nativeModule);
  const varNames = keys.map((k) => `${k}: $${k}`);
  const exportNames = keys.map((k) => `$${k} as ${k}`);
  return {
    source: `
      const { exports } = import.meta;
      const { ${varNames.join(', ')} } = exports;
      export default exports;
      export { ${exportNames.join(', ')} };
    `,
    initializeImportMeta(meta) {
      // TODO(zenparsing): This does not support "live-binding"
      // over the properties of the native module. Is this
      // important? Would "proxifying" break other use cases?
      meta.exports = nativeModule;
    }
  };
}

async function loadFileModule(url) {
  const filename = fileURLToPath(url);
  const source = await readFileAsync(filename, 'utf8');
  // TODO(zenparsing): Assert integrity on the source
  return {
    source: stripShebang(source),
    initializeImportMeta(meta) {
      initializeFileImportMeta(filename, meta);
    }
  };
}

function initializeFileImportMeta(filename, meta) {
  let requireFn;
  function require(request) {
    if (!requireFn) requireFn = createRequire(filename);
    return requireFn(request);
  }

  meta.require = require;
  meta.filename = filename;
  meta.dirname = dirname(filename);
}

const resolver = new ModuleResolver({
  useGlobalPaths: false,
  packageMainKeys: ['module']
});

async function resolve(specifier, parentURL) {
  if (NativeModule.canBeRequiredByUsers(specifier))
    return `node:${specifier}`;

  const resolveOpts = {
    isMain: !parentURL,
    extensions: EXTENSIONS
  };

  const filename = resolver.resolve(
    toPath(specifier),
    toPath(parentURL),
    resolveOpts);

  return pathToFileURL(filename).href;
}

async function load(url) {
  if (isBuiltinURL(url))
    return loadNativeModule(url.slice(5));

  return loadFileModule(url);
}

module.exports = new ModuleLoader({ resolve, load });
