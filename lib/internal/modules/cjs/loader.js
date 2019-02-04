// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

'use strict';

const { NativeModule } = require('internal/bootstrap/loaders');
const { pathToFileURL } = require('internal/url');
const util = require('util');
const vm = require('vm');
const assert = require('internal/assert');
const fs = require('fs');
const path = require('path');
const ModuleResolver = require('internal/modules/cjs/resolver');
const { URL } = require('url');
const {
  makeRequireFunction,
  requireDepth,
  stripBOM,
  stripShebang
} = require('internal/modules/cjs/helpers');
const { getOptionValue } = require('internal/options');
const manifest = getOptionValue('--experimental-policy') ?
  require('internal/process/policy').manifest :
  null;
const { isPromise } = require('internal/util/types');
const { ERR_INVALID_ARG_VALUE } = require('internal/errors').codes;
const { validateString } = require('internal/validators');
const { importModule } = require('internal/process/esm_loader');

module.exports = Module;

const {
  CHAR_UPPERCASE_A,
  CHAR_LOWERCASE_A,
  CHAR_UPPERCASE_Z,
  CHAR_LOWERCASE_Z,
  CHAR_FORWARD_SLASH,
  CHAR_BACKWARD_SLASH,
  CHAR_DOT,
  CHAR_UNDERSCORE,
  CHAR_0,
  CHAR_9,
} = require('internal/constants');

const isWindows = process.platform === 'win32';

function updateChildren(parent, child, scan) {
  var children = parent && parent.children;
  if (children && !(scan && children.includes(child)))
    children.push(child);
}

function Module(id, parent) {
  this.id = id;
  this.exports = {};
  this.parent = parent;
  updateChildren(parent, this, false);
  this.filename = null;
  this.loaded = false;
  this.children = [];
}

const builtinModules = [];
for (const [id, mod] of NativeModule.map) {
  if (mod.canBeRequiredByUsers) {
    builtinModules.push(id);
  }
}

Object.freeze(builtinModules);
Module.builtinModules = builtinModules;

Module._cache = Object.create(null);
Module._pathCache = Object.create(null);
Module._extensions = Object.create(null);
var modulePaths = [];
Module.globalPaths = [];

Module.wrap = function(script) {
  return Module.wrapper[0] + script + Module.wrapper[1];
};

Module.wrapper = [
  '(function (exports, require, module, __filename, __dirname) { ',
  '\n});'
];

const debug = util.debuglog('module');

Module._debug = util.deprecate(debug, 'Module._debug is deprecated.',
                               'DEP0077');

const moduleResolver = new ModuleResolver({
  extensions: {
    [Symbol.iterator]() {
      return Object.keys(Module._extensions).values();
    }
  },
  useGlobalPaths: true,
  packageMainKeys: ['main', 'module']
});

// Find the longest (possibly multi-dot) extension registered in
// Module._extensions
function findLongestRegisteredExtension(filename) {
  const name = path.basename(filename);
  let currentExtension;
  let index;
  let startIndex = 0;
  while ((index = name.indexOf('.', startIndex)) !== -1) {
    startIndex = index + 1;
    if (index === 0) continue; // Skip dotfiles like .gitignore
    currentExtension = name.slice(index);
    if (Module._extensions[currentExtension]) return currentExtension;
  }
  return '.js';
}

Module._findPath = function(request, paths, isMain) {
  const result = moduleResolver._findPath(request, paths, { isMain });
  return result || false;
};

Module._nodeModulePaths = (from) => {
  return moduleResolver._nodeModulePaths(from);
};

// 'index.' character codes
var indexChars = [ 105, 110, 100, 101, 120, 46 ];
var indexLen = indexChars.length;
Module._resolveLookupPaths = function(request, parent, newReturn) {
  if (NativeModule.canBeRequiredByUsers(request)) {
    debug('looking for %j in []', request);
    return (newReturn ? null : [request, []]);
  }

  // Check for non-relative path
  if (request.length < 2 ||
      request.charCodeAt(0) !== CHAR_DOT ||
      (request.charCodeAt(1) !== CHAR_DOT &&
       request.charCodeAt(1) !== CHAR_FORWARD_SLASH &&
       (!isWindows || request.charCodeAt(1) !== CHAR_BACKWARD_SLASH))) {
    var paths = modulePaths;
    if (parent) {
      if (!parent.paths)
        paths = parent.paths = [];
      else
        paths = parent.paths.concat(paths);
    }

    // Maintain backwards compat with certain broken uses of require('.')
    // by putting the module's directory in front of the lookup paths.
    if (request === '.') {
      if (parent && parent.filename) {
        paths.unshift(path.dirname(parent.filename));
      } else {
        paths.unshift(path.resolve(request));
      }
    }

    debug('looking for %j in %j', request, paths);
    return (newReturn ? (paths.length > 0 ? paths : null) : [request, paths]);
  }

  // with --eval, parent.id is not set and parent.filename is null
  if (!parent || !parent.id || !parent.filename) {
    // Make require('./path/to/foo') work - normally the path is taken
    // from realpath(__filename) but with eval there is no filename
    var mainPaths = ['.'].concat(Module._nodeModulePaths('.'), modulePaths);

    debug('looking for %j in %j', request, mainPaths);
    return (newReturn ? mainPaths : [request, mainPaths]);
  }

  // Is the parent an index module?
  // We can assume the parent has a valid extension,
  // as it already has been accepted as a module.
  const base = path.basename(parent.filename);
  var parentIdPath;
  if (base.length > indexLen) {
    var i = 0;
    for (; i < indexLen; ++i) {
      if (indexChars[i] !== base.charCodeAt(i))
        break;
    }
    if (i === indexLen) {
      // We matched 'index.', let's validate the rest
      for (; i < base.length; ++i) {
        const code = base.charCodeAt(i);
        if (code !== CHAR_UNDERSCORE &&
            (code < CHAR_0 || code > CHAR_9) &&
            (code < CHAR_UPPERCASE_A || code > CHAR_UPPERCASE_Z) &&
            (code < CHAR_LOWERCASE_A || code > CHAR_LOWERCASE_Z))
          break;
      }
      if (i === base.length) {
        // Is an index module
        parentIdPath = parent.id;
      } else {
        // Not an index module
        parentIdPath = path.dirname(parent.id);
      }
    } else {
      // Not an index module
      parentIdPath = path.dirname(parent.id);
    }
  } else {
    // Not an index module
    parentIdPath = path.dirname(parent.id);
  }
  var id = path.resolve(parentIdPath, request);

  // Make sure require('./path') and require('path') get distinct ids, even
  // when called from the toplevel js file
  if (parentIdPath === '.' &&
      id.indexOf('/') === -1 &&
      (!isWindows || id.indexOf('\\') === -1)) {
    id = './' + id;
  }

  debug('RELATIVE: requested: %s set ID to: %s from %s', request, id,
        parent.id);

  var parentDir = [path.dirname(parent.filename)];
  debug('looking for %j in %j', id, parentDir);
  return (newReturn ? parentDir : [id, parentDir]);
};

// Check the cache for the requested file.
// 1. If a module already exists in the cache: return its exports object.
// 2. If the module is native: call `NativeModule.require()` with the
//    filename and return the result.
// 3. Otherwise, create a new module for the file and save it to the cache.
//    Then have it load  the file contents before returning its exports
//    object.
Module._load = function(request, parent, isMain) {
  if (parent) {
    debug('Module._load REQUEST %s parent: %s', request, parent.id);
  }

  var filename = Module._resolveFilename(request, parent, isMain);

  var cachedModule = Module._cache[filename];
  if (cachedModule) {
    updateChildren(parent, cachedModule, true);
    return cachedModule.exports;
  }

  if (NativeModule.canBeRequiredByUsers(filename)) {
    debug('load native module %s', request);
    return NativeModule.require(filename);
  }

  // Don't call updateChildren(), Module constructor already does.
  var module = new Module(filename, parent);

  if (isMain) {
    process.mainModule = module;
    module.id = '.';
  }

  Module._cache[filename] = module;

  tryModuleLoad(module, filename);

  return module.exports;
};

function tryModuleLoad(module, filename) {
  var threw = true;
  try {
    module.load(filename);
    threw = false;
  } finally {
    if (threw) {
      delete Module._cache[filename];
    }
  }
}

Module._resolveFilename = function(request, parent, isMain, options) {
  if (NativeModule.canBeRequiredByUsers(request)) {
    return request;
  }

  var paths;

  if (typeof options === 'object' && options !== null &&
      Array.isArray(options.paths)) {
    const fakeParent = new Module('', null);

    paths = [];

    for (var i = 0; i < options.paths.length; i++) {
      const path = options.paths[i];
      fakeParent.paths = Module._nodeModulePaths(path);
      const lookupPaths = Module._resolveLookupPaths(request, fakeParent, true);

      for (var j = 0; j < lookupPaths.length; j++) {
        if (!paths.includes(lookupPaths[j]))
          paths.push(lookupPaths[j]);
      }
    }
  } else {
    paths = Module._resolveLookupPaths(request, parent, true);
  }

  // Look up the filename first, since that's the cache key.
  var filename = Module._findPath(request, paths, isMain);
  if (!filename) {
    // eslint-disable-next-line no-restricted-syntax
    var err = new Error(`Cannot find module '${request}'`);
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }
  return filename;
};


// Given a file name, pass it to the proper extension handler.
Module.prototype.load = function(filename) {
  debug('load %j for module %j', filename, this.id);

  assert(!this.loaded);
  this.filename = filename;
  this.paths = Module._nodeModulePaths(path.dirname(filename));

  var extension = findLongestRegisteredExtension(filename);
  Module._extensions[extension](this, filename);
  this.loaded = true;
};


// Loads a module at the given file path. Returns that module's
// `exports` property.
Module.prototype.require = function(id) {
  validateString(id, 'id');
  if (id === '') {
    throw new ERR_INVALID_ARG_VALUE('id', id,
                                    'must be a non-empty string');
  }
  return Module._load(id, this, /* isMain */ false);
};


// Resolved path to process.argv[1] will be lazily placed here
// (needed for setting breakpoint when called with --inspect-brk)
var resolvedArgv;

function normalizeReferrerURL(referrer) {
  if (typeof referrer === 'string' && path.isAbsolute(referrer)) {
    return pathToFileURL(referrer).href;
  }
  return new URL(referrer).href;
}

function esmSyntaxError(err) {
  // TODO(zenparsing): We detect when something that appears to be a
  // module is parsed as a script by looking for special syntax errors
  // thrown by V8. What is the best way to detect these errors without
  // binding so tightly to a particular engine?
  // A temporary alternative is to use a regex on the source code
  // /(^|\n)\s*(import|export)\s+[^(]/.
  return err instanceof SyntaxError && (
    err.message === 'Cannot use \'import.meta\' outside a module' ||
    err.message === 'Import declaration cannot appear outside a module' ||
    err.message === 'Export declaration cannot appear outside a module'
  );
}

// Run the file contents in the correct scope or sandbox. Expose
// the correct helper variables (require, module, exports) to
// the file.
// Returns exception, if any.
Module.prototype._compile = function(content, filename) {
  if (manifest) {
    const moduleURL = pathToFileURL(filename);
    manifest.assertIntegrity(moduleURL, content);
  }

  content = stripShebang(content);

  // create wrapper function
  var wrapper = Module.wrap(content);
  var compiledWrapper;

  try {
    compiledWrapper = vm.runInThisContext(wrapper, {
      filename: filename,
      lineOffset: 0,
      displayErrors: true,
      importModuleDynamically(specifier) {
        return importModule(specifier, normalizeReferrerURL(filename));
      },
    });
  } catch (err) {
    if (esmSyntaxError(err)) {
      this.exports = importModule(pathToFileURL(filename).href);
      return;
    }
    throw err;
  }

  var inspectorWrapper = null;
  if (process._breakFirstLine && process._eval == null) {
    if (!resolvedArgv) {
      // We enter the repl if we're not given a filename argument.
      if (process.argv[1]) {
        resolvedArgv = Module._resolveFilename(process.argv[1], null, false);
      } else {
        resolvedArgv = 'repl';
      }
    }

    // Set breakpoint on module start
    if (filename === resolvedArgv) {
      delete process._breakFirstLine;
      inspectorWrapper = internalBinding('inspector').callAndPauseOnStart;
    }
  }
  var dirname = path.dirname(filename);
  var require = makeRequireFunction(this);
  var depth = requireDepth;
  if (depth === 0) moduleResolver._statCache = new Map();
  var result;
  var exports = this.exports;
  var thisValue = exports;
  var module = this;
  if (inspectorWrapper) {
    result = inspectorWrapper(compiledWrapper, thisValue, exports,
                              require, module, filename, dirname);
  } else {
    result = compiledWrapper.call(thisValue, exports, require, module,
                                  filename, dirname);
  }
  if (depth === 0) moduleResolver._statCache = new Map();
  return result;
};


// Native extension for .js
Module._extensions['.js'] = function(module, filename) {
  var content = fs.readFileSync(filename, 'utf8');
  module._compile(stripBOM(content), filename);
};


// Native extension for .json
Module._extensions['.json'] = function(module, filename) {
  const content = fs.readFileSync(filename, 'utf8');

  if (manifest) {
    const moduleURL = pathToFileURL(filename);
    manifest.assertIntegrity(moduleURL, content);
  }

  try {
    module.exports = JSON.parse(stripBOM(content));
  } catch (err) {
    err.message = filename + ': ' + err.message;
    throw err;
  }
};


// Native extension for .node
Module._extensions['.node'] = function(module, filename) {
  if (manifest) {
    const content = fs.readFileSync(filename);
    const moduleURL = pathToFileURL(filename);
    manifest.assertIntegrity(moduleURL, content);
  }
  // be aware this doesn't use `content`
  return process.dlopen(module, path.toNamespacedPath(filename));
};

Module._extensions['.mjs'] = function(module, filename) {
  module.exports = importModule(pathToFileURL(filename).href);
};

// bootstrap main module.
Module.runMain = function() {
  // Load the main module--the command line argument.
  const exports = Module._load(process.argv[1], null, true);
  if (isPromise(exports)) {
    exports.catch((e) => {
      internalBinding('util').triggerFatalException(e);
    });
  }

  // Handle any nextTicks added in the first tick of the program
  process._tickCallback();
};

Module.createRequireFromPath = (filename) => {
  const m = new Module(filename);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  return makeRequireFunction(m);
};

Module._initPaths = function() {
  modulePaths = ModuleResolver.getGlobalPaths();

  // clone as a shallow copy, for introspection.
  Module.globalPaths = modulePaths.slice(0);
};

Module._preloadModules = function(requests) {
  if (!Array.isArray(requests))
    return null;

  // Preloaded modules have a dummy parent module which is deemed to exist
  // in the current working directory. This seeds the search path for
  // preloaded modules.
  var parent = new Module('internal/preload', null);
  try {
    parent.paths = Module._nodeModulePaths(process.cwd());
  } catch (e) {
    if (e.code !== 'ENOENT') {
      throw e;
    }
  }

  let current = 0;
  function resume() {
    if (current >= requests.length) {
      return null;
    }
    while (current < requests.length) {
      const exports = parent.require(requests[current++]);
      if (isPromise(exports)) {
        // TODO(zenparsing): Should we guard against "then"
        // monkey-patching?
        return exports.then(resume);
      }
    }
  }

  return resume();
};

Module._initPaths();

// Backwards compatibility
Module.Module = Module;
