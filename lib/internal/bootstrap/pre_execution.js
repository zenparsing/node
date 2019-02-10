'use strict';

const { getOptionValue } = require('internal/options');

// In general deprecations are intialized wherever the APIs are implemented,
// this is used to deprecate APIs implemented in C++ where the deprecation
// utitlities are not easily accessible.
function initializeDeprecations() {
  const { deprecate } = require('internal/util');
  const pendingDeprecation = getOptionValue('--pending-deprecation');

  // DEP0103: access to `process.binding('util').isX` type checkers
  // TODO(addaleax): Turn into a full runtime deprecation.
  const utilBinding = internalBinding('util');
  const types = require('internal/util/types');
  for (const name of [
    'isArrayBuffer',
    'isArrayBufferView',
    'isAsyncFunction',
    'isDataView',
    'isDate',
    'isExternal',
    'isMap',
    'isMapIterator',
    'isNativeError',
    'isPromise',
    'isRegExp',
    'isSet',
    'isSetIterator',
    'isTypedArray',
    'isUint8Array',
    'isAnyArrayBuffer'
  ]) {
    utilBinding[name] = pendingDeprecation ?
      deprecate(types[name],
                'Accessing native typechecking bindings of Node ' +
                'directly is deprecated. ' +
                `Please use \`util.types.${name}\` instead.`,
                'DEP0103') :
      types[name];
  }
}

function initializeClusterIPC() {
  // If this is a worker in cluster mode, start up the communication
  // channel. This needs to be done before any user code gets executed
  // (including preload modules).
  if (process.argv[1] && process.env.NODE_UNIQUE_ID) {
    const cluster = require('cluster');
    cluster._setupWorker();
    // Make sure it's not accidentally inherited by child processes.
    delete process.env.NODE_UNIQUE_ID;
  }
}

function initializePolicy() {
  const experimentalPolicy = getOptionValue('--experimental-policy');
  if (experimentalPolicy) {
    process.emitWarning('Policies are experimental.',
                        'ExperimentalWarning');
    const { pathToFileURL, URL } = require('url');
    // URL here as it is slightly different parsing
    // no bare specifiers for now
    let manifestURL;
    if (require('path').isAbsolute(experimentalPolicy)) {
      manifestURL = new URL(`file:///${experimentalPolicy}`);
    } else {
      const cwdURL = pathToFileURL(process.cwd());
      cwdURL.pathname += '/';
      manifestURL = new URL(experimentalPolicy, cwdURL);
    }
    const fs = require('fs');
    const src = fs.readFileSync(manifestURL, 'utf8');
    require('internal/process/policy')
      .setup(src, manifestURL.href);
  }
}

function initializeESMLoader() {
  const {
    setImportModuleDynamicallyCallback,
    setInitializeImportMetaObjectCallback
  } = internalBinding('module_wrap');
  const esm = require('internal/process/esm_loader');
  // Setup per-isolate callbacks that locate data or callbacks that we keep
  // track of for different ESM modules.
  setInitializeImportMetaObjectCallback(esm.initializeImportMetaObject);
  setImportModuleDynamicallyCallback(esm.importModuleDynamicallyCallback);
}

function loadPreloadModules(callback) {
  // For user code, we preload modules if `-r` is passed
  const requests = getOptionValue('--require');
  if (Array.isArray(requests) && requests.length > 0) {
    const { _preloadModules } = require('internal/modules/cjs/loader');
    _preloadModules(requests)
      .then(callback)
      .catch((e) => {
        internalBinding('util').triggerFatalException(e);
      });
  } else {
    // TODO(zenparsing): We execute the callback synchronously here
    // in order to preserve existing behavior when preload modules
    // are not used. Is this necessary?
    callback();
  }
}

module.exports = {
  initializeDeprecations,
  initializeClusterIPC,
  initializePolicy,
  initializeESMLoader,
  loadPreloadModules
};
