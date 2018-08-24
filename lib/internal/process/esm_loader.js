'use strict';

const { internalBinding } = require('internal/bootstrap/loaders');
const {
  setImportModuleDynamicallyCallback,
  setInitializeImportMetaObjectCallback
} = internalBinding('module_wrap');

const { getURLFromFilePath } = require('internal/url');
const Loader = require('internal/modules/esm/loader');
const path = require('path');
const { URL } = require('url');
const {
  initImportMetaMap,
  wrapToModuleMap
} = require('internal/vm/source_text_module');

function normalizeReferrerURL(referrer) {
  if (typeof referrer === 'string' && path.isAbsolute(referrer)) {
    return getURLFromFilePath(referrer).href;
  }
  return new URL(referrer).href;
}

function initializeImportMetaObject(wrap, meta) {
  const vmModule = wrapToModuleMap.get(wrap);
  if (vmModule === undefined) {
    // This ModuleWrap belongs to the Loader.
    meta.url = wrap.url;
  } else {
    const initializeImportMeta = initImportMetaMap.get(vmModule);
    if (initializeImportMeta !== undefined) {
      // This ModuleWrap belongs to vm.SourceTextModule,
      // initializer callback was provided.
      initializeImportMeta(meta, vmModule);
    }
  }
}

let loaderResolve;
exports.loaderPromise = new Promise((resolve, reject) => {
  loaderResolve = resolve;
});

exports.ESMLoader = undefined;

exports.setup = function() {
  setInitializeImportMetaObjectCallback(initializeImportMetaObject);

  const ESMLoader = new Loader();

  loaderResolve(ESMLoader);

  setImportModuleDynamicallyCallback(async (referrer, specifier) => {
    return ESMLoader.import(specifier, normalizeReferrerURL(referrer));
  });

  exports.ESMLoader = ESMLoader;
};
