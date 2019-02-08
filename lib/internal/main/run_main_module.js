'use strict';

const {
  initializeDeprecations,
  initializeClusterIPC,
  initializePolicy,
  initializeESMLoader,
  loadPreloadModules
} = require('internal/bootstrap/pre_execution');

initializeDeprecations();
initializeClusterIPC();
initializePolicy();
initializeESMLoader();
loadPreloadModules(() => {
  // Expand process.argv[1] into a full path.
  const path = require('path');
  process.argv[1] = path.resolve(process.argv[1]);

  const CJSModule = require('internal/modules/cjs/loader');

  markBootstrapComplete();

  CJSModule.runMain();
});

// Handle any nextTicks added in the first tick of the program
process._tickCallback();
