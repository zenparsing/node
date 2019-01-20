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
const { ESMLoader } = require('internal/process/esm_loader');

const readFileAsync = promisify(fs.readFile);

const debug = debuglog('esm');

const translators = new SafeMap();
exports.translators = translators;

function initializeImportMeta(meta, { url }) {
  const filename = internalURLModule.fileURLToPath(url);
  meta.require = CJSModule.createRequireFromPath(filename);
  meta.filename = filename;
  meta.dirname = dirname(filename);
  meta.url = url;
}

async function importModuleDynamically(specifier, { url }) {
  return ESMLoader.import(specifier, url);
}

// Strategy for loading a standard JavaScript module
translators.set('esm', async (url) => {
  debug(`Translating StandardModule ${url}`);
  const source = stripShebang(`${await readFileAsync(new URL(url))}`);
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
  // TODO(zenparsing): This had to be updated after we disabled
  // proxifying native modules. Investigate if we should reenable.
  const exportKeys = Object.keys(module.exports);
  return createDynamicModule(
    [...exportKeys, 'default'], url, (reflect) => {
      debug(`Loading BuiltinModule ${url}`);
      module.reflect = reflect;
      for (const key of exportKeys)
        reflect.exports[key].set(module.exports[key]);
      reflect.exports.default.set(module.exports);
    });
});
