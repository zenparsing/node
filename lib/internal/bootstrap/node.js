// Hello, and welcome to hacking node.js!
//
// This file is invoked by node::LoadEnvironment in src/node.cc, and is
// responsible for bootstrapping the node.js core. As special caution is given
// to the performance of the startup process, many dependencies are invoked
// lazily.
//
// Before this file is run, lib/internal/bootstrap/loaders.js gets run first
// to bootstrap the internal binding and module loaders, including
// process.binding(), process._linkedBinding(), internalBinding() and
// NativeModule. And then { internalBinding, NativeModule } will be passed
// into this bootstrapper to bootstrap Node.js core.
'use strict';

// This file is compiled as if it's wrapped in a function with arguments
// passed by node::LoadEnvironment()
/* global process, loaderExports, isMainThread */

const { internalBinding, NativeModule } = loaderExports;

const { getOptionValue } = NativeModule.require('internal/options');
const config = internalBinding('config');

function startup() {
  setupTraceCategoryState();

  setupProcessObject();

  // TODO(joyeecheung): this does not have to done so early, any fatal errors
  // thrown before user code execution should simply crash the process
  // and we do not care about any clean up at that point. We don't care
  // about emitting any events if the process crash upon bootstrap either.
  {
    const {
      fatalException,
      setUncaughtExceptionCaptureCallback,
      hasUncaughtExceptionCaptureCallback
    } = NativeModule.require('internal/process/execution');

    process._fatalException = fatalException;
    process.setUncaughtExceptionCaptureCallback =
      setUncaughtExceptionCaptureCallback;
    process.hasUncaughtExceptionCaptureCallback =
      hasUncaughtExceptionCaptureCallback;
  }

  setupGlobalVariables();

  // Bootstrappers for all threads, including worker threads and main thread
  const perThreadSetup = NativeModule.require('internal/process/per_thread');
  // Bootstrappers for the main thread only
  let mainThreadSetup;
  // Bootstrappers for the worker threads only
  let workerThreadSetup;
  if (isMainThread) {
    mainThreadSetup = NativeModule.require(
      'internal/process/main_thread_only'
    );
  } else {
    workerThreadSetup = NativeModule.require(
      'internal/process/worker_thread_only'
    );
  }

  // process.config is serialized config.gypi
  process.config = JSON.parse(internalBinding('native_module').config);

  const rawMethods = internalBinding('process_methods');
  // Set up methods and events on the process object for the main thread
  if (isMainThread) {
    // This depends on process being an event emitter
    mainThreadSetup.setupSignalHandlers(internalBinding);

    process.abort = rawMethods.abort;
    const wrapped = mainThreadSetup.wrapProcessMethods(rawMethods);
    process.umask = wrapped.umask;
    process.chdir = wrapped.chdir;

    // TODO(joyeecheung): deprecate and remove these underscore methods
    process._debugProcess = rawMethods._debugProcess;
    process._debugEnd = rawMethods._debugEnd;
    process._startProfilerIdleNotifier =
      rawMethods._startProfilerIdleNotifier;
    process._stopProfilerIdleNotifier = rawMethods._stopProfilerIdleNotifier;
  } else {
    const wrapped = workerThreadSetup.wrapProcessMethods(rawMethods);

    process.umask = wrapped.umask;
  }

  // Set up methods on the process object for all threads
  {
    process.cwd = rawMethods.cwd;
    process.dlopen = rawMethods.dlopen;
    process.uptime = rawMethods.uptime;

    // TODO(joyeecheung): either remove them or make them public
    process._getActiveRequests = rawMethods._getActiveRequests;
    process._getActiveHandles = rawMethods._getActiveHandles;

    // TODO(joyeecheung): remove these
    process.reallyExit = rawMethods.reallyExit;
    process._kill = rawMethods._kill;

    const wrapped = perThreadSetup.wrapProcessMethods(rawMethods);
    process._rawDebug = wrapped._rawDebug;
    process.hrtime = wrapped.hrtime;
    process.hrtime.bigint = wrapped.hrtimeBigInt;
    process.cpuUsage = wrapped.cpuUsage;
    process.memoryUsage = wrapped.memoryUsage;
    process.kill = wrapped.kill;
    process.exit = wrapped.exit;
  }

  const {
    onWarning,
    emitWarning
  } = NativeModule.require('internal/process/warning');
  if (!process.noProcessWarnings && process.env.NODE_NO_WARNINGS !== '1') {
    process.on('warning', onWarning);
  }
  process.emitWarning = emitWarning;

  const {
    nextTick,
    runNextTicks
  } = NativeModule.require('internal/process/next_tick').setup();

  process.nextTick = nextTick;
  // Used to emulate a tick manually in the JS land.
  // A better name for this function would be `runNextTicks` but
  // it has been exposed to the process object so we keep this legacy name
  // TODO(joyeecheung): either remove it or make it public
  process._tickCallback = runNextTicks;

  const credentials = internalBinding('credentials');
  if (credentials.implementsPosixCredentials) {
    process.getuid = credentials.getuid;
    process.geteuid = credentials.geteuid;
    process.getgid = credentials.getgid;
    process.getegid = credentials.getegid;
    process.getgroups = credentials.getgroups;

    if (isMainThread) {
      const wrapped = mainThreadSetup.wrapPosixCredentialSetters(credentials);
      process.initgroups = wrapped.initgroups;
      process.setgroups = wrapped.setgroups;
      process.setegid = wrapped.setegid;
      process.seteuid = wrapped.seteuid;
      process.setgid = wrapped.setgid;
      process.setuid = wrapped.setuid;
    }
  }

  if (isMainThread) {
    const { getStdout, getStdin, getStderr } =
      NativeModule.require('internal/process/stdio').getMainThreadStdio();
    setupProcessStdio(getStdout, getStdin, getStderr);
  } else {
    const { getStdout, getStdin, getStderr } =
      workerThreadSetup.initializeWorkerStdio();
    setupProcessStdio(getStdout, getStdin, getStderr);
  }

  if (config.hasInspector) {
    const {
      enable,
      disable
    } = NativeModule.require('internal/inspector_async_hook');
    internalBinding('inspector').registerAsyncHook(enable, disable);
  }

  // If the process is spawned with env NODE_CHANNEL_FD, it's probably
  // spawned by our child_process module, then initialize IPC.
  // This attaches some internal event listeners and creates:
  // process.send(), process.channel, process.connected,
  // process.disconnect()
  if (isMainThread && process.env.NODE_CHANNEL_FD) {
    mainThreadSetup.setupChildProcessIpcChannel();
  }

  // TODO(joyeecheung): move this down further to get better snapshotting
  if (getOptionValue('[has_experimental_policy]')) {
    process.emitWarning('Policies are experimental.',
                        'ExperimentalWarning');
    const experimentalPolicy = getOptionValue('--experimental-policy');
    const { pathToFileURL, URL } = NativeModule.require('url');
    // URL here as it is slightly different parsing
    // no bare specifiers for now
    let manifestURL;
    if (NativeModule.require('path').isAbsolute(experimentalPolicy)) {
      manifestURL = new URL(`file:///${experimentalPolicy}`);
    } else {
      const cwdURL = pathToFileURL(process.cwd());
      cwdURL.pathname += '/';
      manifestURL = new URL(experimentalPolicy, cwdURL);
    }
    const fs = NativeModule.require('fs');
    const src = fs.readFileSync(manifestURL, 'utf8');
    NativeModule.require('internal/process/policy')
      .setup(src, manifestURL.href);
  }

  const browserGlobals = !process._noBrowserGlobals;
  if (browserGlobals) {
    setupGlobalTimeouts();
    setupGlobalConsole();
    setupGlobalURL();
    setupGlobalEncoding();
    setupQueueMicrotask();
  }

  setupDOMException();

  // On OpenBSD process.execPath will be relative unless we
  // get the full path before process.execPath is used.
  if (process.platform === 'openbsd') {
    const { realpathSync } = NativeModule.require('fs');
    process.execPath = realpathSync.native(process.execPath);
  }

  Object.defineProperty(process, 'argv0', {
    enumerable: true,
    configurable: false,
    value: process.argv[0]
  });
  process.argv[0] = process.execPath;

  // Handle `--debug*` deprecation and invalidation.
  if (process._invalidDebug) {
    process.emitWarning(
      '`node --debug` and `node --debug-brk` are invalid. ' +
      'Please use `node --inspect` or `node --inspect-brk` instead.',
      'DeprecationWarning', 'DEP0062', startup, true);
    process.exit(9);
  } else if (process._deprecatedDebugBrk) {
    process.emitWarning(
      '`node --inspect --debug-brk` is deprecated. ' +
      'Please use `node --inspect-brk` instead.',
      'DeprecationWarning', 'DEP0062', startup, true);
  }

  const experimentalVMModules = getOptionValue('--experimental-vm-modules');
  if (experimentalVMModules) {
    process.emitWarning(
      'The ESM module loader is experimental.',
      'ExperimentalWarning', undefined);
  }

  NativeModule.require('internal/process/esm_loader').setup();

  const { deprecate } = NativeModule.require('internal/util');
  {
    // Install legacy getters on the `util` binding for typechecking.
    // TODO(addaleax): Turn into a full runtime deprecation.
    const pendingDeprecation = getOptionValue('--pending-deprecation');
    const utilBinding = internalBinding('util');
    const types = NativeModule.require('internal/util/types');
    for (const name of [
      'isArrayBuffer', 'isArrayBufferView', 'isAsyncFunction',
      'isDataView', 'isDate', 'isExternal', 'isMap', 'isMapIterator',
      'isNativeError', 'isPromise', 'isRegExp', 'isSet', 'isSetIterator',
      'isTypedArray', 'isUint8Array', 'isAnyArrayBuffer'
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

  // process.allowedNodeEnvironmentFlags
  Object.defineProperty(process, 'allowedNodeEnvironmentFlags', {
    get() {
      const flags = perThreadSetup.buildAllowedFlags();
      process.allowedNodeEnvironmentFlags = flags;
      return process.allowedNodeEnvironmentFlags;
    },
    // If the user tries to set this to another value, override
    // this completely to that value.
    set(value) {
      Object.defineProperty(this, 'allowedNodeEnvironmentFlags', {
        value,
        configurable: true,
        enumerable: true,
        writable: true
      });
    },
    enumerable: true,
    configurable: true
  });
  // process.assert
  process.assert = deprecate(
    perThreadSetup.assert,
    'process.assert() is deprecated. Please use the `assert` module instead.',
    'DEP0100');

  // TODO(joyeecheung): this property has not been well-maintained, should we
  // deprecate it in favor of a better API?
  const { isDebugBuild, hasOpenSSL } = config;
  Object.defineProperty(process, 'features', {
    enumerable: true,
    writable: false,
    configurable: false,
    value: {
      debug: isDebugBuild,
      uv: true,
      ipv6: true,  // TODO(bnoordhuis) ping libuv
      tls_alpn: hasOpenSSL,
      tls_sni: hasOpenSSL,
      tls_ocsp: hasOpenSSL,
      tls: hasOpenSSL
    }
  });

  // Set up coverage exit hooks.
  let originalReallyExit = process.reallyExit;
  // Core coverage generation using nyc instrumented lib/ files.
  // See `make coverage-build`. This does not affect user land.
  // TODO(joyeecheung): this and `with_instrumentation.js` can be
  // removed in favor of NODE_V8_COVERAGE once we switch to that
  // in https://coverage.nodejs.org/
  if (global.__coverage__) {
    const {
      writeCoverage
    } = NativeModule.require('internal/coverage-gen/with_instrumentation');
    process.on('exit', writeCoverage);
    originalReallyExit = process.reallyExit = (code) => {
      writeCoverage();
      originalReallyExit(code);
    };
  }
  // User-facing NODE_V8_COVERAGE environment variable that writes
  // ScriptCoverage to a specified file.
  if (process.env.NODE_V8_COVERAGE) {
    const cwd = NativeModule.require('internal/process/execution').tryGetCwd();
    const { resolve } = NativeModule.require('path');
    // Resolve the coverage directory to an absolute path, and
    // overwrite process.env so that the original path gets passed
    // to child processes even when they switch cwd.
    const coverageDirectory = resolve(cwd, process.env.NODE_V8_COVERAGE);
    process.env.NODE_V8_COVERAGE = coverageDirectory;
    const {
      writeCoverage,
      setCoverageDirectory
    } = NativeModule.require('internal/coverage-gen/with_profiler');
    setCoverageDirectory(coverageDirectory);
    process.on('exit', writeCoverage);
    process.reallyExit = (code) => {
      writeCoverage();
      originalReallyExit(code);
    };
  }

  const perf = internalBinding('performance');
  const {
    NODE_PERFORMANCE_MILESTONE_BOOTSTRAP_COMPLETE,
  } = perf.constants;
  perf.markMilestone(NODE_PERFORMANCE_MILESTONE_BOOTSTRAP_COMPLETE);

  if (isMainThread) {
    return startMainThreadExecution;
  } else {
    return startWorkerThreadExecution;
  }
}

function startWorkerThreadExecution() {
  prepareUserCodeExecution();

  // If we are in a worker thread, execute the script sent through the
  // message port.
  const {
    getEnvMessagePort,
    threadId
  } = internalBinding('worker');
  const {
    createMessageHandler,
    createWorkerFatalExeception
  } = NativeModule.require('internal/process/worker_thread_only');

  // Set up the message port and start listening
  const debug = NativeModule.require('util').debuglog('worker');
  debug(`[${threadId}] is setting up worker child environment`);

  const port = getEnvMessagePort();
  port.on('message', createMessageHandler(port));
  port.start();

  // Overwrite fatalException
  process._fatalException = createWorkerFatalExeception(port);
}

// There are various modes that Node can run in. The most common two
// are running from a script and running the REPL - but there are a few
// others like the debugger or running --eval arguments. Here we decide
// which mode we run in.
function startMainThreadExecution(mainScript) {
  if (mainScript) {
    process.nextTick(() => {
      NativeModule.require(mainScript);
    });
    return;
  }

  // `node inspect ...` or `node debug ...`
  if (process.argv[1] === 'inspect' || process.argv[1] === 'debug') {
    if (process.argv[1] === 'debug') {
      process.emitWarning(
        '`node debug` is deprecated. Please use `node inspect` instead.',
        'DeprecationWarning', 'DEP0068');
    }

    // Start the debugger agent.
    process.nextTick(() => {
      NativeModule.require('internal/deps/node-inspect/lib/_inspect').start();
    });
    return;
  }

  // node --help
  if (getOptionValue('--help')) {
    NativeModule.require('internal/print_help').print(process.stdout);
    return;
  }

  // e.g. node --completion-bash >> ~/.bashrc
  if (getOptionValue('--completion-bash')) {
    NativeModule.require('internal/bash_completion').print(process.stdout);
    return;
  }

  // `node --prof-process`
  if (getOptionValue('--prof-process')) {
    NativeModule.require('internal/v8_prof_processor');
    return;
  }

  // There is user code to be run.
  prepareUserCodeExecution();
  executeUserCode();
}

function prepareUserCodeExecution() {
  // If this is a worker in cluster mode, start up the communication
  // channel. This needs to be done before any user code gets executed
  // (including preload modules).
  if (process.argv[1] && process.env.NODE_UNIQUE_ID) {
    const cluster = NativeModule.require('cluster');
    cluster._setupWorker();
    // Make sure it's not accidentally inherited by child processes.
    delete process.env.NODE_UNIQUE_ID;
  }

  // For user code, we preload modules if `-r` is passed
  const preloadModules = getOptionValue('--require');
  if (preloadModules) {
    const {
      _preloadModules
    } = NativeModule.require('internal/modules/cjs/loader');
    _preloadModules(preloadModules);
  }
}

function executeUserCode() {
  // User passed `-e` or `--eval` arguments to Node without `-i` or
  // `--interactive`.
  // Note that the name `forceRepl` is merely an alias of `interactive`
  // in code.
  if (getOptionValue('[has_eval_string]') && !getOptionValue('--interactive')) {
    const {
      addBuiltinLibsToObject
    } = NativeModule.require('internal/modules/cjs/helpers');
    addBuiltinLibsToObject(global);
    const source = getOptionValue('--eval');
    const { evalScript } = NativeModule.require('internal/process/execution');
    evalScript('[eval]', source, process._breakFirstLine);
    return;
  }

  // If the first argument is a file name, run it as a main script
  if (process.argv[1] && process.argv[1] !== '-') {
    // Expand process.argv[1] into a full path.
    const path = NativeModule.require('path');
    process.argv[1] = path.resolve(process.argv[1]);

    const CJSModule = NativeModule.require('internal/modules/cjs/loader');

    // If user passed `-c` or `--check` arguments to Node, check its syntax
    // instead of actually running the file.
    if (getOptionValue('--check')) {
      const fs = NativeModule.require('fs');
      // Read the source.
      const filename = CJSModule._resolveFilename(process.argv[1]);
      const source = fs.readFileSync(filename, 'utf-8');
      checkScriptSyntax(source, filename);
      process.exit(0);
    }

    // Note: this actually tries to run the module as a ESM first
    // TODO(joyeecheung): can we move that logic to here? Note that this
    // is an undocumented method available via `require('module').runMain`
    CJSModule.runMain();
    return;
  }

  // Create the REPL if `-i` or `--interactive` is passed, or if
  // stdin is a TTY.
  // Note that the name `forceRepl` is merely an alias of `interactive`
  // in code.
  if (process._forceRepl || NativeModule.require('tty').isatty(0)) {
    const cliRepl = NativeModule.require('internal/repl');
    cliRepl.createInternalRepl(process.env, (err, repl) => {
      if (err) {
        throw err;
      }
      repl.on('exit', () => {
        if (repl._flushing) {
          repl.pause();
          return repl.once('flushHistory', () => {
            process.exit();
          });
        }
        process.exit();
      });
    });

    // User passed '-e' or '--eval' along with `-i` or `--interactive`
    if (process._eval != null) {
      const { evalScript } = NativeModule.require('internal/process/execution');
      evalScript('[eval]', process._eval, process._breakFirstLine);
    }
    return;
  }

  // Stdin is not a TTY, we will read it and execute it.
  readAndExecuteStdin();
}

function readAndExecuteStdin() {
  process.stdin.setEncoding('utf8');

  let code = '';
  process.stdin.on('data', (d) => {
    code += d;
  });

  process.stdin.on('end', () => {
    if (process._syntax_check_only != null) {
      checkScriptSyntax(code, '[stdin]');
    } else {
      process._eval = code;
      const { evalScript } = NativeModule.require('internal/process/execution');
      evalScript('[stdin]', process._eval, process._breakFirstLine);
    }
  });
}

function setupTraceCategoryState() {
  const {
    traceCategoryState,
    setTraceCategoryStateUpdateHandler
  } = internalBinding('trace_events');
  const kCategoryAsyncHooks = 0;
  let traceEventsAsyncHook;

  function toggleTraceCategoryState() {
    // Dynamically enable/disable the traceEventsAsyncHook
    const asyncHooksEnabled = !!traceCategoryState[kCategoryAsyncHooks];

    if (asyncHooksEnabled) {
      // Lazy load internal/trace_events_async_hooks only if the async_hooks
      // trace event category is enabled.
      if (!traceEventsAsyncHook) {
        traceEventsAsyncHook =
          NativeModule.require('internal/trace_events_async_hooks');
      }
      traceEventsAsyncHook.enable();
    } else if (traceEventsAsyncHook) {
      traceEventsAsyncHook.disable();
    }
  }

  toggleTraceCategoryState();
  setTraceCategoryStateUpdateHandler(toggleTraceCategoryState);
}

function setupProcessObject() {
  const EventEmitter = NativeModule.require('events');
  const origProcProto = Object.getPrototypeOf(process);
  Object.setPrototypeOf(origProcProto, EventEmitter.prototype);
  EventEmitter.call(process);
}

function setupProcessStdio(getStdout, getStdin, getStderr) {
  Object.defineProperty(process, 'stdout', {
    configurable: true,
    enumerable: true,
    get: getStdout
  });

  Object.defineProperty(process, 'stderr', {
    configurable: true,
    enumerable: true,
    get: getStderr
  });

  Object.defineProperty(process, 'stdin', {
    configurable: true,
    enumerable: true,
    get: getStdin
  });

  process.openStdin = function() {
    process.stdin.resume();
    return process.stdin;
  };
}

function setupGlobalVariables() {
  Object.defineProperty(global, Symbol.toStringTag, {
    value: 'global',
    writable: false,
    enumerable: false,
    configurable: true
  });
  Object.defineProperty(global, 'process', {
    value: process,
    enumerable: false,
    writable: true,
    configurable: true
  });
  const util = NativeModule.require('util');

  function makeGetter(name) {
    return util.deprecate(function() {
      return this;
    }, `'${name}' is deprecated, use 'global'`, 'DEP0016');
  }

  function makeSetter(name) {
    return util.deprecate(function(value) {
      Object.defineProperty(this, name, {
        configurable: true,
        writable: true,
        enumerable: true,
        value: value
      });
    }, `'${name}' is deprecated, use 'global'`, 'DEP0016');
  }

  Object.defineProperties(global, {
    GLOBAL: {
      configurable: true,
      get: makeGetter('GLOBAL'),
      set: makeSetter('GLOBAL')
    },
    root: {
      configurable: true,
      get: makeGetter('root'),
      set: makeSetter('root')
    }
  });

  const { Buffer } = NativeModule.require('buffer');
  const bufferBinding = internalBinding('buffer');

  // Only after this point can C++ use Buffer::New()
  bufferBinding.setBufferPrototype(Buffer.prototype);
  delete bufferBinding.setBufferPrototype;
  delete bufferBinding.zeroFill;

  Object.defineProperty(global, 'Buffer', {
    value: Buffer,
    enumerable: false,
    writable: true,
    configurable: true
  });

  process.domain = null;
  process._exiting = false;
}

function setupGlobalTimeouts() {
  const timers = NativeModule.require('timers');
  global.clearImmediate = timers.clearImmediate;
  global.clearInterval = timers.clearInterval;
  global.clearTimeout = timers.clearTimeout;
  global.setImmediate = timers.setImmediate;
  global.setInterval = timers.setInterval;
  global.setTimeout = timers.setTimeout;
}

function setupGlobalConsole() {
  const consoleFromVM = global.console;
  const consoleFromNode =
    NativeModule.require('internal/console/global');
  // Override global console from the one provided by the VM
  // to the one implemented by Node.js
  Object.defineProperty(global, 'console', {
    configurable: true,
    enumerable: false,
    value: consoleFromNode,
    writable: true
  });
  // TODO(joyeecheung): can we skip this if inspector is not active?
  if (config.hasInspector) {
    const inspector =
      NativeModule.require('internal/console/inspector');
    inspector.addInspectorApis(consoleFromNode, consoleFromVM);
    // This will be exposed by `require('inspector').console` later.
    inspector.consoleFromVM = consoleFromVM;
  }
}

function setupGlobalURL() {
  const { URL, URLSearchParams } = NativeModule.require('internal/url');
  Object.defineProperties(global, {
    URL: {
      value: URL,
      writable: true,
      configurable: true,
      enumerable: false
    },
    URLSearchParams: {
      value: URLSearchParams,
      writable: true,
      configurable: true,
      enumerable: false
    }
  });
}

function setupGlobalEncoding() {
  const { TextEncoder, TextDecoder } = NativeModule.require('util');
  Object.defineProperties(global, {
    TextEncoder: {
      value: TextEncoder,
      writable: true,
      configurable: true,
      enumerable: false
    },
    TextDecoder: {
      value: TextDecoder,
      writable: true,
      configurable: true,
      enumerable: false
    }
  });
}

function setupQueueMicrotask() {
  Object.defineProperty(global, 'queueMicrotask', {
    get() {
      process.emitWarning('queueMicrotask() is experimental.',
                          'ExperimentalWarning');
      const { queueMicrotask } =
        NativeModule.require('internal/queue_microtask');

      Object.defineProperty(global, 'queueMicrotask', {
        value: queueMicrotask,
        writable: true,
        enumerable: false,
        configurable: true,
      });
      return queueMicrotask;
    },
    set(v) {
      Object.defineProperty(global, 'queueMicrotask', {
        value: v,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    },
    enumerable: false,
    configurable: true,
  });
}

function setupDOMException() {
  // Registers the constructor with C++.
  const DOMException = NativeModule.require('internal/domexception');
  const { registerDOMException } = internalBinding('messaging');
  registerDOMException(DOMException);
}

function checkScriptSyntax(source, filename) {
  const CJSModule = NativeModule.require('internal/modules/cjs/loader');
  const vm = NativeModule.require('vm');
  const {
    stripShebang, stripBOM
  } = NativeModule.require('internal/modules/cjs/helpers');

  // Remove Shebang.
  source = stripShebang(source);
  // Remove BOM.
  source = stripBOM(source);
  // Wrap it.
  source = CJSModule.wrap(source);
  // Compile the script, this will throw if it fails.
  new vm.Script(source, { displayErrors: true, filename });
}

return startup();
