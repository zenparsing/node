'use strict';

const {
  setImportModuleDynamicallyCallback,
  setInitializeImportMetaObjectCallback,
  callbackMap,
} = internalBinding('module_wrap');

const Loader = require('internal/modules/esm/loader');
const {
  wrapToModuleMap,
} = require('internal/vm/source_text_module');
const {
  ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING,
} = require('internal/errors').codes;

function initializeImportMetaObject(wrap, meta) {
  if (callbackMap.has(wrap)) {
    const { initializeImportMeta } = callbackMap.get(wrap);
    if (initializeImportMeta !== undefined) {
      // TODO(zenparsing): throwing from here causes an ugly crash.
      // Should this be fixed on the C++ side?
      initializeImportMeta(meta, wrapToModuleMap.get(wrap) || wrap);
    }
  }
}

async function importModuleDynamicallyCallback(wrap, specifier) {
  if (callbackMap.has(wrap)) {
    const { importModuleDynamically } = callbackMap.get(wrap);
    if (importModuleDynamically !== undefined) {
      return importModuleDynamically(
        specifier, wrapToModuleMap.get(wrap) || wrap);
    }
  }
  throw new ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING();
}

setInitializeImportMetaObjectCallback(initializeImportMetaObject);
setImportModuleDynamicallyCallback(importModuleDynamicallyCallback);

const ESMLoader = new Loader();
const importModule = ESMLoader.import.bind(ESMLoader);

exports.importModule = importModule;

exports.setup = function() {
  require('internal/modules/cjs/loader')._import = importModule;
};
