'use strict';

const { NativeModule } = require('internal/bootstrap/loaders');
const { ModuleWrap, callbackMap } = internalBinding('module_wrap');
const { stripShebang } = require('internal/modules/cjs/helpers');
const CJSModule = require('internal/modules/cjs/loader');
const internalURLModule = require('internal/url');
const createDynamicModule = require(
  'internal/modules/esm/create_dynamic_module');
const fs = require('fs');
const { dirname } = require('path');
const { SafeMap } = require('internal/safe_globals');
const { URL } = require('url');
const { debuglog, promisify } = require('util');
const esmLoader = require('internal/process/esm_loader');

const readFileAsync = promisify(fs.readFile);

const debug = debuglog('esm');

const translators = new SafeMap();
module.exports = translators;

function initializeImportMeta(meta, { url }) {
  const filename = internalURLModule.fileURLToPath(url);
  meta.require = CJSModule.createRequireFromPath(filename);
  meta.filename = filename;
  meta.dirname = dirname(filename);
  meta.url = url;
}

async function importModuleDynamically(specifier, { url }) {
  const loader = await esmLoader.loaderPromise;
  return loader.import(specifier, url);
}

const mainModulePrelude =
  'var require = import.meta.require, ' +
    '__dirname = import.meta.dirname, ' +
    '__filename = import.meta.filename, ' +
    'module = process.mainModule, ' +
    'exports = module.exports;';

function setProcessMainModule(url) {
  if (process.mainModule) {
    return;
  }
  const filename = process.argv[1];
  const module = new CJSModule(filename, null);
  module.id = '.';
  module.filename = filename;
  module.paths = CJSModule._nodeModulePaths(dirname(filename));
  process.mainModule = module;
}

// Strategy for loading a standard JavaScript module
translators.set('esm', async (url, isMain) => {
  let source = stripShebang(`${await readFileAsync(new URL(url))}`);
  if (isMain) {
    setProcessMainModule();
    source = mainModulePrelude + source;
  }
  debug(`Translating StandardModule ${url}`);
  const module = new ModuleWrap(source, url);
  callbackMap.set(module, {
    initializeImportMeta,
    importModuleDynamically,
  });
  return {
    module,
    reflect: undefined,
  };
});

// Strategy for loading a node builtin CommonJS module that isn't
// through normal resolution
translators.set('builtin', async (url) => {
  debug(`Translating BuiltinModule ${url}`);
  // slice 'node:' scheme
  const id = url.slice(5);
  NativeModule.require(id);
  const module = NativeModule.map.get(id);
  return createDynamicModule(
    [...module.exportKeys, 'default'], url, (reflect) => {
      debug(`Loading BuiltinModule ${url}`);
      module.reflect = reflect;
      for (const key of module.exportKeys)
        reflect.exports[key].set(module.exports[key]);
      reflect.exports.default.set(module.exports);
    });
});
