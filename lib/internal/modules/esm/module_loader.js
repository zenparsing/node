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

const { isContext } = internalBinding('contextify');
const { decorateErrorStack } = require('internal/util');
const { ERR_INVALID_ARG_TYPE } = require('internal/errors').codes;
const { URL } = require('url');

function str(x) {
  return `${x}`;
}

class ModuleLoader {

  constructor(options) {
    const { context, resolve, load } = options;

    if (context !== undefined) {
      if (typeof context !== 'object' || context === null)
        throw new ERR_INVALID_ARG_TYPE(
          'options.context', 'Object', context);

      if (!isContext(context))
        throw new ERR_INVALID_ARG_TYPE(
          'options.context', 'vm.Context', context);
    }

    if (typeof resolve !== 'function')
      throw new ERR_INVALID_ARG_TYPE(
        'options.resolve', 'function', options.resolve);

    if (typeof load !== 'function')
      throw new ERR_INVALID_ARG_TYPE(
        'options.load', 'function', options.load);

    this._context = context;
    this._resolve = resolve;
    this._load = load;
    this._moduleMap = new Map(); // url => Promise<{error}|{module}>
    this._linkMap = new Map(); // module => Promise<[module]>
    this._importMetaMap = new Map(); // url => function
  }

  compile(source, options = {}) {
    source = str(source);

    if (options.url === undefined)
      throw new ERR_INVALID_ARG_TYPE(
        'options.url', 'string', options.url);

    const url = new URL(options.url).href;

    const { initializeImportMeta } = options;
    if (initializeImportMeta !== undefined) {
      if (typeof initializeImportMeta !== 'function')
        throw new ERR_INVALID_ARG_TYPE(
          'options.initializeImportMeta', 'function', initializeImportMeta);
    }

    const module = new ModuleWrap(str(source), url, this._context);

    return {
      run: async () => {
        if (this._moduleMap.has(url))
          throw new Error('A module is already loaded for this url');

        if (initializeImportMeta)
          this._importMetaMap.set(url, initializeImportMeta);

        this._linkModuleGraph(module);
        await this._instantiateAndEvaluate(module);
        return module.getNamespace();
      }
    };
  }

  initializeImportMeta(url, meta) {
    meta.url = url;
    const initializeImportMeta = this._importMetaMap.get(url);
    if (initializeImportMeta) {
      this._importMetaMap.delete(url);
      initializeImportMeta(meta);
    }
  }

  async import(specifier, parentURL) {
    const { _resolve } = this;
    const url = str(await _resolve(specifier, parentURL));
    const module = await this._getModule(url);
    const isMain = !parentURL;
    this._linkModuleGraph(module);
    await this._instantiateAndEvaluate(module, isMain);
    return module.getNamespace();
  }

  async _getModule(url) {
    let promise = this._moduleMap.get(url);
    if (!promise) {
      promise = this._loadModule(url);
      this._moduleMap.set(url, promise);
      promise.catch((err) => {
        this._moduleMap.delete(url);
        throw err;
      });
    }

    const { error, module } = await promise;

    if (error)
      throw error;

    return module;
  }

  async _loadModule(url) {
    const { _load } = this;
    const { source, initializeImportMeta } = await _load(url);

    try {
      const module = new ModuleWrap(str(source), url, this._context);

      if (typeof initializeImportMeta === 'function')
        this._importMetaMap.set(url, initializeImportMeta);

      return { module };
    } catch (error) {
      // Translation and parsing errors are stored in
      // the module map
      return { error };
    }
  }

  _linkModuleGraph(module) {
    let promise = this._linkMap.get(module);
    if (!promise) {
      const { _resolve } = this;
      const specifiers = module.getDependencySpecifiers();
      promise = Promise.all(specifiers.map(async (specifier) => {
        const url = str(await _resolve(specifier, module.url));
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

  async _graphLinked(module) {
    for (const dep of await this._linkMap.get(module)) {
      await this._graphLinked(dep);
    }
    // After a module is known to be fully linked, we do
    // not need to traverse the graph again
    this._linkMap.set(module, Promise.resolve([]));
  }

  async _instantiateAndEvaluate(module, isMain = false) {
    await this._graphLinked(module);

    switch (module.getStatus()) {
      case kUninstantiated:
        this._instantiateModule(module, isMain);
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

  _instantiateModule(module, isMain) {
    try {
      if (isMain && process._breakFirstLine) {
        delete process._breakFirstLine;
        const { callAndPauseOnStart } = internalBinding('inspector');
        callAndPauseOnStart(module.instantiate, module);
      } else {
        module.instantiate();
      }
      module.evaluate(/* timeout */ -1, /* breakOnSigInt */ false);
    } catch (e) {
      decorateErrorStack(e);
      throw e;
    }
  }

}

module.exports = ModuleLoader;
