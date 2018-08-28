'use strict';

const ModuleLoader = require('internal/modules/esm/module_loader');
const { stripShebang } = require('internal/modules/cjs/helpers');
const { fileURLToPath } = require('internal/url');
const { NativeModule } = require('internal/bootstrap/loaders');
const ModuleResolver = require('internal/modules/esm/resolver');
const fs = require('fs');
const { promisify } = require('util');
const { URL } = require('url');
const { extname } = require('path');
const { getOptionValue } = require('internal/options');
const {
  ERR_INVALID_URL_SCHEME,
  ERR_UNKNOWN_FILE_EXTENSION
} = require('internal/errors').codes;

const readFileAsync = promisify(fs.readFile);

const manifest = getOptionValue('--experimental-policy') ?
  require('internal/process/policy').manifest :
  null;

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
      // TODO(zenparsing): Consider supporting "live-binding"
      // over the properties of the native module, so that
      // modifications to native modules from CJS will be
      // visible from ES modules
      meta.exports = nativeModule;
    }
  };
}

function createRequire(filename) {
  // Lazy load CJS loader in order to avoid circular
  // dependencies between ESM and CJS loaders
  const CJSModule = require('internal/modules/cjs/loader');
  return CJSModule.createRequireFromPath(filename);
}

async function loadFileModule(url) {
  const filename = fileURLToPath(url);
  const ext = extname(filename);

  if (ext !== '.js' && ext !== '.mjs')
    throw new ERR_UNKNOWN_FILE_EXTENSION(filename);

  const source = await readFileAsync(filename, 'utf8');

  if (manifest)
    manifest.assertIntegrity(new URL(url), source);

  return {
    source: stripShebang(source),
    initializeImportMeta(meta) {
      meta.url = url;

      let requireFn;
      meta.require = function require(request) {
        if (!requireFn)
          requireFn = createRequire(filename);
        return requireFn(request);
      };
    }
  };
}

const resolver = new ModuleResolver();

async function resolve(specifier, parentURL, options) {
  if (NativeModule.canBeRequiredByUsers(specifier))
    return `node:${specifier}`;

  return resolver.resolve(specifier, parentURL, options);
}

async function load(url) {
  const parsed = new URL(url);
  switch (parsed.protocol) {
    case 'node:': return loadNativeModule(parsed.pathname);
    case 'file:': return loadFileModule(url);
    default: throw new ERR_INVALID_URL_SCHEME('file:');
  }
}

module.exports = new ModuleLoader({ resolve, load });
