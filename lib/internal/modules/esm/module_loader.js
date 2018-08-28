'use strict';

const {
  ModuleWrap,
  kUninstantiated,
  kInstantiating,
  kInstantiated,
  kEvaluating,
  kEvaluated,
  kErrored
} = internalBinding('module_wrap');

const {
  makeRequireFunction,
  stripShebang
} = require('internal/modules/cjs/helpers');

const {
  fileURLToPath,
  pathToFileURL
} = require('internal/url');

const { ERR_INVALID_ARG_TYPE } = require('internal/errors').codes;
const { NativeModule } = require('internal/bootstrap/loaders');
const ModuleResolver = require('internal/modules/cjs/resolver');
const { decorateErrorStack } = require('internal/util');
const fs = require('fs');
const { dirname } = require('path');
const { promisify } = require('util');

const readFileAsync = promisify(fs.readFile);
const StringStartsWith = Function.call.bind(String.prototype.startsWith);
const EXTENSIONS = ['.mjs', '.js'];

function toPath(s) {
  if (!s) return null;
  if (StringStartsWith(s, 'file:')) return fileURLToPath(s);
  return decodeURIComponent(s);
}

function instantiateModule(module, isMain) {
  try {
    if (isMain && process._breakFirstLine) {
      // TODO(zenparsing): Add a short explanation of this behavior
      delete process._breakFirstLine;
      const { callAndPauseOnStart } = internalBinding('inspector');
      callAndPauseOnStart(module.instantiate, module);
    } else {
      module.instantiate();
    }
    module.evaluate(/* timeout */ -1, /* breakOnSigint */ false);
  } catch (e) {
    decorateErrorStack(e);
    throw e;
  }
}

function createRequire(filename) {
  // Lazy load CJS loader in order to avoid circular
  // dependencies between ESM and CJS loaders
  const CJSModule = require('internal/modules/cjs/loader');
  const m = new CJSModule(filename);
  m.filename = filename;
  m.paths = CJSModule._nodeModulePaths(dirname(filename));
  return makeRequireFunction(m);
}

async function loadNativeModule(id) {
  const nativeModule = NativeModule.require(id);
  const keys = Object.keys(nativeModule);
  const varNames = keys.map((k) => `${k}: $$${k}`);
  const exportNames = keys.map((k) => `$$${k} as ${k}`);
  return {
    source: `
      const { exports } = import.meta;
      const { ${varNames.join(', ')} } = exports;
      export default exports;
      export { ${exportNames.join(', ')} };
    `,
    initializeImportMeta(meta) {
      // TODO(zenparsing): This does not support "live-binding"
      // over the properties of the native module. Is this
      // important? Would "proxifying" break other use cases?
      meta.exports = nativeModule;
    }
  };
}

async function loadFileModule(url) {
  const filename = fileURLToPath(url);
  return {
    source: await readFileAsync(filename, 'utf8'),
    initializeImportMeta(meta) {
      let requireFn;
      function require(request) {
        if (!requireFn) requireFn = createRequire(filename);
        return requireFn(request);
      }

      meta.require = require;
      meta.filename = filename;
      meta.dirname = dirname(filename);
      meta.url = url;
    }
  };
}

function str(s) {
  return s ? '' + s : undefined;
}

function normalizeLoadResult(result) {
  if (!result)
    return;

  let { source, initializeImportMeta } = result;
  source = str(source);
  if (typeof initializeImportMeta !== 'function')
    initializeImportMeta = undefined;

  return { source, initializeImportMeta };
}

class ModuleLoader {

  constructor() {
    this._resolver = new ModuleResolver({
      useGlobalPaths: false,
      packageMainKeys: ['module'],
      getExtensions: () => this._getExtensions()
    });

    this._plugins = new Set();

    // Map<url, { error } | { module, initializeImportMeta? }>
    this._moduleMap = new Map();

    // Map<module, Promise<[module]>>
    this._linkMap = new Map();
  }

  addPlugin(plugin) {
    if (!plugin || typeof plugin !== 'object')
      throw new ERR_INVALID_ARG_TYPE('plugin', 'object', plugin);

    this._plugins.add(plugin);
  }

  removePlugin(plugin) {
    this._plugins.delete(plugin);
  }

  async resolve(specifier, parentURL) {
    if (this._plugins.size > 0) {
      for (const plugin of this._plugins) {
        if (typeof plugin.resolve === 'function') {
          const result = str(await plugin.resolve(specifier, parentURL));
          if (result)
            return result;
        }
      }
    }

    if (NativeModule.canBeRequiredByUsers(specifier))
      return `node:${specifier}`;

    const isMain = !parentURL;
    const filename = this._resolver.resolve(
      toPath(specifier),
      toPath(parentURL),
      { isMain });

    return pathToFileURL(filename).href;
  }

  async load(url) {
    if (this._plugins.size > 0) {
      for (const plugin of this._plugins) {
        if (typeof plugin.load === 'function') {
          const result = normalizeLoadResult(await plugin.load(url));
          if (result)
            return result;
        }
      }
    }

    if (StringStartsWith(url, 'node:'))
      return loadNativeModule(url.slice(5));

    return loadFileModule(url);
  }

  async translate(source, url) {
    source = stripShebang(source);

    if (this._plugins.size > 0) {
      for (const plugin of this._plugins) {
        if (typeof plugin.translate === 'function') {
          const result = str(await plugin.translate(source, url));
          if (result)
            source = result;
        }
      }
    }

    return source;
  }

  initializeImportMeta(url, meta) {
    const { initializeImportMeta } = this._moduleMap.get(url) || {};
    if (typeof initializeImportMeta === 'function') {
      initializeImportMeta(meta);
    }
  }

  async import(specifier, parentURL) {
    const url = await this.resolve(specifier, parentURL);
    const module = await this._getModule(url);
    const isMain = !parentURL;
    this._linkModuleGraph(module);
    await this._instantiateModule(module, isMain);
    return module.getNamespace();
  }

  async _getModule(url) {
    let entry = this._moduleMap.get(url);

    if (!entry) {
      entry = await this._loadModule(url);
      this._moduleMap.set(url, entry);
    }

    if (entry.error)
      throw entry.error;

    return entry.module;
  }

  async _loadModule(url) {
    const loadResult = await this.load(url);
    const { source, initializeImportMeta } = loadResult;
    try {
      const translated = await this.translate(source, url);
      return {
        module: new ModuleWrap(translated, url),
        initializeImportMeta,
      };
    } catch (error) {
      // Translation and parsing errors are stored in
      // the module map
      return { error };
    }
  }

  _linkModuleGraph(module) {
    let promise = this._linkMap.get(module);
    if (!promise) {
      const specifiers = module.getDependencySpecifiers();
      promise = Promise.all(specifiers.map(async (specifier) => {
        const url = await this.resolve(specifier, module.url);
        const dep = await this._getModule(url);
        module.resolveDependency(specifier, dep);
        this._linkModuleGraph(dep);
        return dep;
      }));
      // Do not trigger unhandled rejection warnings for
      // failures here. Rejections are be processed in
      // _graphLinked
      promise.catch(() => {});
      this._linkMap.set(module, promise);
    }
  }

  async _instantiateModule(module, isMain) {
    await this._graphLinked(module);

    switch (module.getStatus()) {
      case kUninstantiated:
        instantiateModule(module, isMain);
        break;
      case kInstantiating:
      case kInstantiated:
      case kEvaluating:
        // Instantiation and evaluation are synchronous and occur
        // within the same job. After awaiting the module will be
        // either evaluated or errored.
        await Promise.resolve();
        break;
      case kEvaluated:
        break;
    }

    if (module.getStatus() === kErrored)
      throw module.getError();
  }

  async _graphLinked(module) {
    for (const dep of await this._linkMap.get(module)) {
      await this._graphLinked(dep);
    }
    // After a module is known to be fully linked, we do
    // not need to traverse the graph again
    this._linkMap.set(module, Promise.resolve([]));
  }

  _getExtensions() {
    if (this._plugins.size === 0)
      return EXTENSIONS;

    const list = EXTENSIONS.slice(0);
    for (const plugin of this._plugins) {
      if (plugin && Array.isArray(plugin.extensions)) {
        for (const ext of plugin.extensions) {
          if (typeof ext === 'string' && ext.charAt(0) === '.')
            list.push(ext);
        }
      }
    }

    return list;
  }

}

module.exports = ModuleLoader;
