'use strict';

const esmLoader = require('internal/modules/esm/default_loader');
const path = require('path');
const { pathToFileURL } = require('internal/url');

function initializeImportMetaObject(meta, url, loader) {
  if (!loader)
    loader = esmLoader;

  loader.initializeImportMeta(meta, url);
}

async function importModuleDynamically(specifier, url, loader) {
  if (path.isAbsolute(url))
    url = pathToFileURL(url).href;

  if (!loader)
    loader = esmLoader;

  return loader.importModule(specifier, url);
}

module.exports = {
  initializeImportMetaObject,
  importModuleDynamically,
};
