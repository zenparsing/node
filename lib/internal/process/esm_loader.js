'use strict';

const ModuleLoader = require('internal/modules/esm/module_loader');
const moduleLoader = new ModuleLoader();

exports.initializeImportMetaObject = function(wrap, meta) {
  moduleLoader.initializeImportMeta(wrap.url, meta);
};

exports.importModuleDynamicallyCallback = async function(wrap, specifier) {
  return moduleLoader.import(specifier, wrap.url);
};

exports.importModule = function(specifier, url) {
  return moduleLoader.import(specifier, url);
};
