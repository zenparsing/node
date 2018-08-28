'use strict';

const esmLoader = require('internal/modules/esm/default_loader');
const { pathToFileURL } = require('internal/url');

function importMetaCallback(wrap, meta) {
  esmLoader.initializeImportMeta(wrap.url, meta);
}

async function importCallback(wrap, specifier, resourceName) {
  const url = wrap.url || pathToFileURL(resourceName).href;
  return esmLoader.import(specifier, url);
}

exports.initializeImportMetaObject = importMetaCallback;
exports.importModuleDynamicallyCallback = importCallback;
