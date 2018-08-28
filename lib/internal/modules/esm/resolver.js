'use strict';

const { internalModuleStat } = internalBinding('fs');
const { CHAR_FORWARD_SLASH, CHAR_DOT } = require('internal/constants');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const { pathToFileURL, fileURLToPath } = require('internal/url');
const internalFS = require('internal/fs/utils');
const { nodeModulePaths } = require('internal/modules/cjs/helpers');
const { getOptionValue } = require('internal/options');

const preserveSymlinks = getOptionValue('--preserve-symlinks');
const preserveSymlinksMain = getOptionValue('--preserve-symlinks-main');

const manifest = getOptionValue('--experimental-policy') ?
  require('internal/process/policy').manifest :
  null;

function getSpecifierType(specifier) {
  let state = 'start';
  let i;
  for (i = 0; i < specifier.length; ++i) {
    const c = specifier.charCodeAt(i);
    if (state === 'start') {
      if (c === CHAR_FORWARD_SLASH) return 'root';
      if (c !== CHAR_DOT) break;
      state = 'dot';
    } else if (state === 'dot') {
      if (c === CHAR_FORWARD_SLASH) return 'relative';
      if (c !== CHAR_DOT || i > 1) break;
    }
  }

  try {
    new URL(specifier);
    return 'absolute';
  } catch {
    return 'package';
  }
}

function splitPackageSpecifier(specifier) {
  const pos = specifier.indexOf('/');
  return pos >= 0 ?
    [specifier.slice(0, pos), '.' + specifier.slice(pos)] :
    [specifier, ''];
}

function matchExportsMap(exports, search) {
  let matchLength = 0;
  let mapped = null;

  for (const mapKey of Object.keys(exports)) {
    const key = normalizeExportKey(mapKey);
    if (key === null)
      continue;

    if (key.endsWith('/')) {
      const keyLen = key.length;
      if (search.startsWith(key) && matchLength <= keyLen) {
        mapped = exports[mapKey] + '/' + search.slice(keyLen);
        matchLength = keyLen;
      }
    } else if (key === search) {
      return exports[mapKey];
    }
  }

  return mapped;
}

// Given an exports-map key, returns null, the empty string,
// or a path beginning with './'
function normalizeExportKey(key) {
  let state = 'start';
  let i;
  for (i = 0; i < key.length; ++i) {
    const c = key.charCodeAt(i);
    if (state === 'start') {
      if (c === CHAR_DOT) state = 'dot';
      else if (c === CHAR_FORWARD_SLASH) return null;
      else return './' + key;
    } else if (state === 'dot') {
      if (c === CHAR_DOT) return null;
      else if (c === CHAR_FORWARD_SLASH) return key;
      else return './' + key;
    }
  }
  return state === 'dot' ? '' : null;
}

class ModuleResolver {

  constructor() {
    this._realpathCache = new Map();
    this._statCache = new Map();
  }

  resolve(specifier, baseURL, options = {}) {
    let filename = this._resolvePath(specifier, baseURL);
    if (!filename || !this._isFile(filename)) {
      // eslint-disable-next-line no-restricted-syntax
      const err = new Error(`Cannot find module '${specifier}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    filename = this._toRealPath(filename, options.isMain);
    return pathToFileURL(filename);
  }

  _resolvePath(specifier, baseURL) {
    // TODO(zenparsing): Throw meaningful errors instead of
    // returning null and throwing a generic error from the
    // caller.
    switch (getSpecifierType(specifier)) {
      case 'root':
        return null;
      case 'absolute':
        return fileURLToPath(specifier);
      case 'relative':
        return this._resolveRelative(specifier, baseURL);
      default:
        return this._resolvePackage(specifier, baseURL);
    }
  }

  _resolveRelative(specifier, baseURL) {
    if (!baseURL)
      baseURL = pathToFileURL('./_');

    return fileURLToPath(new URL(specifier, baseURL));
  }

  _resolvePackage(specifier, baseURL) {
    const [name, inner] = splitPackageSpecifier(specifier);
    if (inner.endsWith('/'))
      return null;

    const baseDir = baseURL ?
      path.dirname(fileURLToPath(baseURL)) :
      path.resolve('.');

    for (const tryPath of nodeModulePaths(baseDir)) {
      const packageDir = path.resolve(tryPath, name);
      const jsonPath = path.resolve(packageDir, 'package.json');
      if (this._isFile(jsonPath)) {
        const match = this._findPackageExport(jsonPath, inner);
        return match ? path.resolve(packageDir, match) : null;
      }
    }

    return null;
  }

  _findPackageExport(jsonPath, inner) {
    const jsonString = fs.readFileSync(jsonPath, 'utf8');
    if (manifest)
      manifest.assertIntegrity(pathToFileURL(jsonPath), jsonString);

    let exports;
    try {
      exports = JSON.parse(jsonString).exports;
    } catch (e) {
      e.path = jsonPath;
      e.message = `Error parsing ${jsonPath}: ${e.message}`;
      throw e;
    }

    // By default, packages export everything
    if (exports == null)
      return inner ? inner : null;

    if (typeof exports === 'string')
      return inner ? null : exports;

    return matchExportsMap(exports, inner);
  }

  _isFile(filename) {
    return this._stat(filename) === 0;
  }

  _stat(filename) {
    filename = path.toNamespacedPath(filename);
    let result = this._statCache.get(filename);
    if (result !== undefined) return result;
    result = internalModuleStat(filename);
    // TODO(zenparsing): The stat cache should be cleared
    // at times - but when?
    this._statCache.set(filename, result);
    return result;
  }

  _toRealPath(filePath, isMain) {
    if (isMain && preserveSymlinksMain || !isMain && preserveSymlinks)
      return path.resolve(filePath);

    return fs.realpathSync(filePath, {
      [internalFS.realpathCacheKey]: this._realpathCache
    });
  }

}

module.exports = ModuleResolver;
