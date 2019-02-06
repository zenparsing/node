'use strict';

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('internal/url');
const internalFS = require('internal/fs/utils');
const util = require('util');
const { safeGetenv } = internalBinding('credentials');
const { getOptionValue } = require('internal/options');
const preserveSymlinks = getOptionValue('--preserve-symlinks');
const preserveSymlinksMain = getOptionValue('--preserve-symlinks-main');
const {
  internalModuleReadJSON,
  internalModuleStat
} = internalBinding('fs');

const debug = util.debuglog('module');
const manifest = getOptionValue('--experimental-policy') ?
  require('internal/process/policy').manifest :
  null;

const {
  CHAR_FORWARD_SLASH,
  CHAR_BACKWARD_SLASH,
  CHAR_COLON,
  CHAR_DOT,
} = require('internal/constants');

const RC_FILE = 0;
const RC_DIRECTORY = 1;

const isWindows = process.platform === 'win32';

function isRelative(specifier) {
  return (
    specifier.length >= 2 &&
    specifier.charCodeAt(0) === CHAR_DOT && (
      specifier.charCodeAt(1) === CHAR_DOT ||
      specifier.charCodeAt(1) === CHAR_FORWARD_SLASH ||
      (isWindows && specifier.charCodeAt(1) === CHAR_BACKWARD_SLASH)
    )
  );
}

function hasTrailingSlash(specifier) {
  return (
    specifier.length > 0 &&
    specifier.charCodeAt(specifier.length - 1) === CHAR_FORWARD_SLASH ||
    /(?:^|\/)\.?\.$/.test(specifier)
  );
}

// 'node_modules' character codes reversed
const NM_CHARS = [ 115, 101, 108, 117, 100, 111, 109, 95, 101, 100, 111, 110 ];
const NM_LENGTH = NM_CHARS.length;

function nodeModulePathsPosix(from) {
  // guarantee that 'from' is absolute.
  from = path.resolve(from);
  // Return early not only to avoid unnecessary work, but to *avoid* returning
  // an array of two items for a root: [ '//node_modules', '/node_modules' ]
  if (from === '/')
    return ['/node_modules'];

  // note: this approach *only* works when the path is guaranteed
  // to be absolute.  Doing a fully-edge-case-correct path.split
  // that works on both Windows and Posix is non-trivial.
  const paths = [];
  let p = 0;
  let last = from.length;
  let i = from.length;
  while (--i >= 0) {
    const code = from.charCodeAt(i);
    if (code === CHAR_FORWARD_SLASH) {
      if (p !== NM_LENGTH) {
        paths.push(from.slice(0, last) + '/node_modules');
      }
      last = i;
      p = 0;
    } else if (p !== -1) {
      if (NM_CHARS[p] === code) {
        ++p;
      } else {
        p = -1;
      }
    }
  }

  // Append /node_modules to handle root paths.
  paths.push('/node_modules');

  return paths;
}

function nodeModulePathsWindows(from) {
  // guarantee that 'from' is absolute.
  from = path.resolve(from);

  // note: this approach *only* works when the path is guaranteed
  // to be absolute.  Doing a fully-edge-case-correct path.split
  // that works on both Windows and Posix is non-trivial.

  // return root node_modules when path is 'D:\\'.
  // path.resolve will make sure from.length >=3 in Windows.
  if (from.charCodeAt(from.length - 1) === CHAR_BACKWARD_SLASH &&
      from.charCodeAt(from.length - 2) === CHAR_COLON)
    return [from + 'node_modules'];

  const paths = [];
  let p = 0;
  let last = from.length;
  let i = from.length;
  while (--i >= 0) {
    const code = from.charCodeAt(i);
    // The path segment separator check ('\' and '/') was used to get
    // node_modules path for every path segment.
    // Use colon as an extra condition since we can get node_modules
    // path for drive root like 'C:\node_modules' and don't need to
    // parse drive name.
    if (code === CHAR_BACKWARD_SLASH ||
        code === CHAR_FORWARD_SLASH ||
        code === CHAR_COLON) {
      if (p !== NM_LENGTH) {
        paths.push(from.slice(0, last) + '\\node_modules');
      }
      last = i;
      p = 0;
    } else if (p !== -1) {
      if (NM_CHARS[p] === code) {
        ++p;
      } else {
        p = -1;
      }
    }
  }

  return paths;
}

let warnDotResolve = () => {
  // Future calls are a no-op
  warnDotResolve = () => {};
  process.emitWarning(
    'warning: require(\'.\') resolved outside the package ' +
    'directory. This functionality is deprecated and will be removed ' +
    'soon.',
    'DeprecationWarning', 'DEP0019');
};

class ModuleResolver {

  // TODO(zenparsing): Document which underscore methods are in
  // use by the CJS loader

  constructor(options = {}) {
    this._extensions = options.extensions || [];
    this._packageMainKeys = options.packageMainKeys || [];
    this._globalPaths = [];

    if (options.useGlobalPaths)
      this._globalPaths = ModuleResolver.getGlobalPaths();

    this._packageEntryCache = new Map();
    this._pathCache = new Map();
    this._statCache = new Map();
    this._realpathCache = new Map();
  }

  resolve(specifier, base, options) {
    const paths = this._resolveLookupPaths(specifier, base);
    const filename = this._findPath(specifier, paths, options);

    if (!filename) {
      // eslint-disable-next-line no-restricted-syntax
      const err = new Error(`Cannot find module '${specifier}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }

    return filename;
  }

  _stat(filename) {
    filename = path.toNamespacedPath(filename);
    let result = this._statCache.get(filename);
    if (result !== undefined) return result;
    result = internalModuleStat(filename);
    this._statCache.set(filename, result);
    return result;
  }

  _nodeModulePaths(from) {
    return isWindows ?
      nodeModulePathsWindows(from) :
      nodeModulePathsPosix(from);
  }

  _toRealPath(filePath, isMain, followMain = false) {
    // For the main module, we use the preserveSymlinksMain flag instead
    // mainly for backward compatibility, as the preserveSymlinks flag
    // historically has not applied to the main module.  Most likely this
    // was intended to keep .bin/ binaries working, as following those
    // symlinks is usually required for the imports in the corresponding
    // files to resolve; that said, in some use cases following symlinks
    // causes bigger problems which is why the preserveSymlinksMain option
    // is needed.
    if (
      isMain && !followMain && preserveSymlinksMain ||
      !isMain && preserveSymlinks
    ) {
      return path.resolve(filePath);
    }

    return fs.realpathSync(filePath, {
      [internalFS.realpathCacheKey]: this._realpathCache
    });
  }

  _resolveLookupPaths(specifier, base) {
    const baseDir = base ? path.dirname(base) : null;
    let paths;

    if (isRelative(specifier)) {
      if (baseDir) {
        paths = [baseDir];
      } else {
        // Make require('./path/to/foo') work - normally the path is taken
        // from realpath(__filename) but with eval there is no filename
        paths = [
          '.',
          ...this._nodeModulePaths('.'),
          ...this._globalPaths
        ];
      }
    } else {
      paths = baseDir ? this._nodeModulePaths(baseDir) : [];
      paths.push(...this._globalPaths);

      // Maintain backwards compat with certain broken uses of require('.')
      // by putting the module's directory in front of the lookup paths.
      if (specifier === '.')
        paths.unshift(baseDir || path.resolve(specifier));
    }

    debug('looking for %j in %j', specifier, paths);
    return paths;
  }

  _findPath(specifier, paths, options) {
    if (path.isAbsolute(specifier)) {
      paths = [''];
    } else if (paths.length === 0) {
      return null;
    }

    const cacheKey = specifier + '\x00' +
      (paths.length === 1 ? paths[0] : paths.join('\x00'));

    const entry = this._pathCache.get(cacheKey);
    if (entry)
      return entry;

    const trailingSlash = hasTrailingSlash(specifier);
    let filename = null;
    let i;

    for (i = 0; i < paths.length; i++) {
      const curPath = paths[i];

      // Don't search further if path doesn't exist
      if (curPath && this._stat(curPath) < 1)
        continue;

      const tryPath = path.resolve(curPath, specifier);
      const rc = this._stat(tryPath);

      if (!trailingSlash) {
        filename = (rc === RC_FILE) ?
          this._toRealPath(tryPath, options.isMain) :
          this._tryExtensions(tryPath, options);
      }

      if (!filename && rc === RC_DIRECTORY) {
        filename =
          this._tryPackage(tryPath, options) ||
          this._tryExtensions(path.resolve(tryPath, 'index'), options);
      }

      if (filename) {
        this._pathCache.set(cacheKey, filename);

        // Warn once if '.' resolved outside the module dir
        if (specifier === '.' && i > 0)
          warnDotResolve();

        return filename;
      }
    }

    return null;
  }

  _readPackage(requestPath) {
    const entry = this._packageEntryCache.get(requestPath);
    if (entry)
      return entry;

    const jsonPath = path.resolve(requestPath, 'package.json');
    const jsonString = internalModuleReadJSON(path.toNamespacedPath(jsonPath));

    if (jsonString === undefined)
      return null;

    if (manifest)
      manifest.assertIntegrity(pathToFileURL(jsonPath), jsonString);

    let json;

    try {
      json = JSON.parse(jsonString);
    } catch (e) {
      e.path = jsonPath;
      e.message = `Error parsing ${jsonPath}: ${e.message}`;
      throw e;
    }

    for (const key of this._packageMainKeys) {
      const main = json[key];
      if (typeof main === 'string') {
        this._packageEntryCache.set(requestPath, main);
        return main;
      }
    }

    return null;
  }

  _tryFile(requestPath, options = {}) {
    const rc = this._stat(requestPath);
    if (rc !== RC_FILE)
      return null;

    return this._toRealPath(requestPath, options.isMain, true);
  }

  _tryPackage(requestPath, options) {
    const pkg = this._readPackage(requestPath);
    if (!pkg)
      return null;

    const filename = path.resolve(requestPath, pkg);
    return (
      this._tryFile(filename, options) ||
      this._tryExtensions(filename, options) ||
      this._tryExtensions(path.resolve(filename, 'index'), options)
    );
  }

  // Given a path, check if the file exists with any of the set extensions
  _tryExtensions(p, options) {
    for (const ext of this._extensions) {
      const filename = this._tryFile(p + ext, options);
      if (filename)
        return filename;
    }
    return null;
  }

  static getGlobalPaths() {
    let homeDir;
    let nodePath;
    if (isWindows) {
      homeDir = process.env.USERPROFILE;
      nodePath = process.env.NODE_PATH;
    } else {
      homeDir = safeGetenv('HOME');
      nodePath = safeGetenv('NODE_PATH');
    }

    // $PREFIX/lib/node, where $PREFIX is the root of the Node.js installation.
    let prefixDir;
    // process.execPath is $PREFIX/bin/node except on Windows where it is
    // $PREFIX\node.exe.
    if (isWindows) {
      prefixDir = path.resolve(process.execPath, '..');
    } else {
      prefixDir = path.resolve(process.execPath, '..', '..');
    }

    let paths = [path.resolve(prefixDir, 'lib', 'node')];

    if (homeDir) {
      paths.unshift(path.resolve(homeDir, '.node_libraries'));
      paths.unshift(path.resolve(homeDir, '.node_modules'));
    }

    if (nodePath) {
      paths = nodePath
        .split(path.delimiter)
        .filter((path) => Boolean(path))
        .concat(paths);
    }

    return paths;
  }

}

module.exports = ModuleResolver;
