'use strict';

// User passed `-e` or `--eval` arguments to Node without `-i` or
// `--interactive`.

const {
  initializeDeprecations,
  initializeClusterIPC,
  initializePolicy,
  initializeESMLoader,
  loadPreloadModules
} = require('internal/bootstrap/pre_execution');
const { evalScript } = require('internal/process/execution');
const { addBuiltinLibsToObject } = require('internal/modules/cjs/helpers');

const source = require('internal/options').getOptionValue('--eval');
initializeDeprecations();
initializeClusterIPC();
initializePolicy();
initializeESMLoader();
loadPreloadModules(() => {
  addBuiltinLibsToObject(global);
  markBootstrapComplete();
  evalScript('[eval]', source, process._breakFirstLine);
});

// Handle any nextTicks added in the first tick of the program
process._tickCallback();
