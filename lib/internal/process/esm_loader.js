'use strict';

const { callbackMap } = internalBinding('module_wrap');
const Loader = require('internal/modules/esm/loader');
const {
  ERR_DYNAMIC_IMPORT_CALLBACK_MISSING
} = require('internal/errors').codes;

const loaderInstance = new Loader();

exports.initializeImportMetaObject = function(wrap, meta) {
  if (callbackMap.has(wrap)) {
    const { initializeImportMeta } = callbackMap.get(wrap);
    if (initializeImportMeta !== undefined) {
      // TODO(zenparsing): throwing from here causes an ugly crash.
      // Should this be fixed on the C++ side?
      initializeImportMeta(meta, wrap);
    }
  }
};

exports.importModuleDynamicallyCallback = async function(wrap, specifier) {
  if (callbackMap.has(wrap)) {
    const { importModuleDynamically } = callbackMap.get(wrap);
    if (importModuleDynamically !== undefined) {
      return importModuleDynamically(specifier, wrap);
    }
  }
  throw new ERR_DYNAMIC_IMPORT_CALLBACK_MISSING();
};

exports.importModule = function(specifier, url) {
  return loaderInstance.import(specifier, url);
};
