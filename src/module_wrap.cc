#include <algorithm>
#include <limits.h>  // PATH_MAX
#include <sys/stat.h>  // S_IFDIR
#include "module_wrap.h"

#include "env.h"
#include "node_errors.h"
#include "util-inl.h"
#include "node_contextify.h"
#include "node_watchdog.h"

namespace node {
namespace loader {

using errors::TryCatchScope;

using node::contextify::ContextifyContext;
using v8::Array;
using v8::Context;
using v8::Function;
using v8::FunctionCallbackInfo;
using v8::FunctionTemplate;
using v8::HandleScope;
using v8::Integer;
using v8::IntegrityLevel;
using v8::Isolate;
using v8::Just;
using v8::Local;
using v8::Maybe;
using v8::MaybeLocal;
using v8::Module;
using v8::Number;
using v8::Object;
using v8::PrimitiveArray;
using v8::Promise;
using v8::ScriptCompiler;
using v8::ScriptOrigin;
using v8::String;
using v8::Undefined;
using v8::Value;

namespace {

Local<Promise> RejectWithError(Local<Context> context, Local<Value> error) {
  Local<Promise::Resolver> resolver =
      Promise::Resolver::New(context).ToLocalChecked();
  resolver->Reject(context, error).ToChecked();
  return resolver->GetPromise();
}

Local<Context> ContextFromSandbox(Environment* env, Local<Value> sandbox) {
  CHECK(sandbox->IsObject());
  ContextifyContext* contextify =
      ContextifyContext::ContextFromContextifiedSandbox(
        env, sandbox.As<Object>());
  CHECK_NOT_NULL(contextify);
  return contextify->context();
}

MaybeLocal<Object> GetModuleLoaderFromContext(Local<Context> context) {
  Local<Value> val = context->GetEmbedderData(
      ContextEmbedderIndex::kModuleLoaderObject);

  return (!val->IsObject() || val->IsUndefined())
    ? MaybeLocal<Object>()
    : MaybeLocal<Object>(val.As<Object>());
}

std::string ToStdString(Isolate* isolate, Local<String> value) {
  Utf8Value value_utf8(isolate, value.As<String>());
  std::string value_std(*value_utf8, value_utf8.length());
  return value_std;
}


}  // anonymous namespace

ModuleWrap::ModuleWrap(Environment* env,
                       Local<Object> object,
                       Local<Module> module,
                       Local<String> url) :
  BaseObject(env, object) {
  module_.Reset(env->isolate(), module);
  url_.Reset(env->isolate(), url);
}

ModuleWrap::~ModuleWrap() {
  HandleScope scope(env()->isolate());
  Local<Module> module = module_.Get(env()->isolate());
  auto range = env()->hash_to_module_map.equal_range(module->GetIdentityHash());
  for (auto it = range.first; it != range.second; ++it) {
    if (it->second == this) {
      env()->hash_to_module_map.erase(it);
      break;
    }
  }
}

ModuleWrap* ModuleWrap::GetFromModule(Environment* env,
                                      Local<Module> module) {
  auto range = env->hash_to_module_map.equal_range(module->GetIdentityHash());
  for (auto it = range.first; it != range.second; ++it) {
    if (it->second->module_ == module) {
      return it->second;
    }
  }
  return nullptr;
}

void ModuleWrap::New(const FunctionCallbackInfo<Value>& args) {
  Environment* env = Environment::GetCurrent(args);
  Isolate* isolate = env->isolate();

  CHECK(args.IsConstructCall());
  Local<Object> that = args.This();

  const int argc = args.Length();
  CHECK_GE(argc, 2);

  CHECK(args[0]->IsString());
  Local<String> source_text = args[0].As<String>();

  CHECK(args[1]->IsString());
  Local<String> url = args[1].As<String>();

  Local<Context> context;
  Local<Integer> line_offset;
  Local<Integer> column_offset;

  if (argc == 5) {
    // new ModuleWrap(source, url, context?, lineOffset, columnOffset)
    if (args[2]->IsUndefined()) {
      context = that->CreationContext();
    } else {
      context = ContextFromSandbox(env, args[2]);
    }

    CHECK(args[3]->IsNumber());
    line_offset = args[3].As<Integer>();

    CHECK(args[4]->IsNumber());
    column_offset = args[4].As<Integer>();
  } else {
    // new ModuleWrap(source, url)
    context = that->CreationContext();
    line_offset = Integer::New(isolate, 0);
    column_offset = Integer::New(isolate, 0);
  }

  Environment::ShouldNotAbortOnUncaughtScope no_abort_scope(env);
  TryCatchScope try_catch(env);
  Local<Module> module;

  Local<PrimitiveArray> host_defined_options =
      PrimitiveArray::New(isolate, HostDefinedOptions::kLength);
  host_defined_options->Set(isolate, HostDefinedOptions::kType,
                            Number::New(isolate, ScriptType::kModule));
  host_defined_options->Set(isolate, HostDefinedOptions::kURL, url);

  // compile
  {
    ScriptOrigin origin(url,
                        line_offset,                          // line offset
                        column_offset,                        // column offset
                        True(isolate),                        // is cross origin
                        Local<Integer>(),                     // script id
                        Local<Value>(),                       // source map URL
                        False(isolate),                       // is opaque (?)
                        False(isolate),                       // is WASM
                        True(isolate),                        // is ES Module
                        host_defined_options);
    Context::Scope context_scope(context);
    ScriptCompiler::Source source(source_text, origin);
    if (!ScriptCompiler::CompileModule(isolate, &source).ToLocal(&module)) {
      CHECK(try_catch.HasCaught());
      CHECK(!try_catch.Message().IsEmpty());
      CHECK(!try_catch.Exception().IsEmpty());
      AppendExceptionLine(env, try_catch.Exception(), try_catch.Message(),
                          ErrorHandlingMode::MODULE_ERROR);
      try_catch.ReThrow();
      return;
    }
  }

  if (!that->Set(context, env->url_string(), url).FromMaybe(false)) {
    return;
  }

  ModuleWrap* obj = new ModuleWrap(env, that, module, url);
  obj->context_.Reset(isolate, context);

  env->hash_to_module_map.emplace(module->GetIdentityHash(), obj);

  // Initialize resolve cache map to undefined
  int requests_count = module->GetModuleRequestsLength();
  for (int i = 0; i < requests_count; i++) {
    Local<String> specifier = module->GetModuleRequest(i);
    std::string specifier_std = ToStdString(isolate, specifier);
    obj->resolve_cache_[specifier_std].Reset(isolate, Undefined(isolate));
  }

  that->SetIntegrityLevel(context, IntegrityLevel::kFrozen);
  args.GetReturnValue().Set(that);
}

void ModuleWrap::ResolveDependency(const FunctionCallbackInfo<Value>& args) {
  Environment* env = Environment::GetCurrent(args);
  Isolate* isolate = args.GetIsolate();

  CHECK_EQ(args.Length(), 2);

  Local<Object> receiver = args.This();
  ModuleWrap* obj;
  ASSIGN_OR_RETURN_UNWRAP(&obj, receiver);

  if (obj->linked_) {
    env->ThrowError("linking error, already linked");
    return;
  }

  CHECK(args[0]->IsString());
  std::string specifier = ToStdString(isolate, args[0].As<String>());
  if (obj->resolve_cache_.count(specifier) != 1) {
    env->ThrowError("linking error, invalid specifier");
    return;
  }

  CHECK(args[1]->IsObject());
  Local<Object> dependency = args[1].As<Object>();
  if (FromJSObject(dependency) == nullptr) {
    env->ThrowError("linking error, expected a valid module object");
    return;
  }

  obj->resolve_cache_[specifier].Reset(isolate, dependency);
}

void ModuleWrap::Instantiate(const FunctionCallbackInfo<Value>& args) {
  Environment* env = Environment::GetCurrent(args);
  Isolate* isolate = args.GetIsolate();
  ModuleWrap* obj;
  ASSIGN_OR_RETURN_UNWRAP(&obj, args.This());
  Local<Context> context = obj->context_.Get(isolate);
  Local<Module> module = obj->module_.Get(isolate);
  TryCatchScope try_catch(env);
  Maybe<bool> ok = module->InstantiateModule(context, ResolveCallback);

  obj->resolve_cache_.clear();
  obj->linked_ = true;

  if (!ok.FromMaybe(false)) {
    CHECK(try_catch.HasCaught());
    CHECK(!try_catch.Message().IsEmpty());
    CHECK(!try_catch.Exception().IsEmpty());
    AppendExceptionLine(env, try_catch.Exception(), try_catch.Message(),
                        ErrorHandlingMode::MODULE_ERROR);
    try_catch.ReThrow();
    return;
  }
}

void ModuleWrap::Evaluate(const FunctionCallbackInfo<Value>& args) {
  Environment* env = Environment::GetCurrent(args);
  Isolate* isolate = env->isolate();
  ModuleWrap* obj;
  ASSIGN_OR_RETURN_UNWRAP(&obj, args.This());
  Local<Context> context = obj->context_.Get(isolate);
  Local<Module> module = obj->module_.Get(isolate);

  // module.evaluate(timeout, breakOnSigint)
  CHECK_EQ(args.Length(), 2);

  CHECK(args[0]->IsNumber());
  int64_t timeout = args[0]->IntegerValue(env->context()).FromJust();

  CHECK(args[1]->IsBoolean());
  bool break_on_sigint = args[1]->IsTrue();

  Environment::ShouldNotAbortOnUncaughtScope no_abort_scope(env);
  TryCatchScope try_catch(env);

  bool timed_out = false;
  bool received_signal = false;
  MaybeLocal<Value> result;
  if (break_on_sigint && timeout != -1) {
    Watchdog wd(isolate, timeout, &timed_out);
    SigintWatchdog swd(isolate, &received_signal);
    result = module->Evaluate(context);
  } else if (break_on_sigint) {
    SigintWatchdog swd(isolate, &received_signal);
    result = module->Evaluate(context);
  } else if (timeout != -1) {
    Watchdog wd(isolate, timeout, &timed_out);
    result = module->Evaluate(context);
  } else {
    result = module->Evaluate(context);
  }

  // Convert the termination exception into a regular exception.
  if (timed_out || received_signal) {
    env->isolate()->CancelTerminateExecution();
    // It is possible that execution was terminated by another timeout in
    // which this timeout is nested, so check whether one of the watchdogs
    // from this invocation is responsible for termination.
    if (timed_out) {
      THROW_ERR_SCRIPT_EXECUTION_TIMEOUT(env, timeout);
    } else if (received_signal) {
      THROW_ERR_SCRIPT_EXECUTION_INTERRUPTED(env);
    }
  }

  if (try_catch.HasCaught()) {
    try_catch.ReThrow();
    return;
  }

  args.GetReturnValue().Set(result.ToLocalChecked());
}

void ModuleWrap::GetNamespace(const FunctionCallbackInfo<Value>& args) {
  Environment* env = Environment::GetCurrent(args);
  Isolate* isolate = args.GetIsolate();
  ModuleWrap* obj;
  ASSIGN_OR_RETURN_UNWRAP(&obj, args.This());

  Local<Module> module = obj->module_.Get(isolate);

  switch (module->GetStatus()) {
    default:
      return env->ThrowError(
          "cannot get namespace, Module has not been instantiated");
    case v8::Module::Status::kInstantiated:
    case v8::Module::Status::kEvaluating:
    case v8::Module::Status::kEvaluated:
      break;
  }

  Local<Value> result = module->GetModuleNamespace();
  args.GetReturnValue().Set(result);
}

void ModuleWrap::GetStatus(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = args.GetIsolate();
  ModuleWrap* obj;
  ASSIGN_OR_RETURN_UNWRAP(&obj, args.This());

  Local<Module> module = obj->module_.Get(isolate);

  args.GetReturnValue().Set(module->GetStatus());
}

void ModuleWrap::GetDependencySpecifiers(
    const FunctionCallbackInfo<Value>& args) {
  Environment* env = Environment::GetCurrent(args);
  ModuleWrap* obj;
  ASSIGN_OR_RETURN_UNWRAP(&obj, args.This());

  Local<Module> module = obj->module_.Get(env->isolate());

  int count = module->GetModuleRequestsLength();

  Local<Array> specifiers = Array::New(env->isolate(), count);

  for (int i = 0; i < count; i++)
    specifiers->Set(env->context(), i, module->GetModuleRequest(i)).FromJust();

  args.GetReturnValue().Set(specifiers);
}

void ModuleWrap::GetError(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = args.GetIsolate();
  ModuleWrap* obj;
  ASSIGN_OR_RETURN_UNWRAP(&obj, args.This());

  Local<Module> module = obj->module_.Get(isolate);

  args.GetReturnValue().Set(module->GetException());
}

MaybeLocal<Module> ModuleWrap::ResolveCallback(Local<Context> context,
                                               Local<String> specifier,
                                               Local<Module> referrer) {
  Environment* env = Environment::GetCurrent(context);
  CHECK_NOT_NULL(env);  // TODO(addaleax): Handle nullptr here.
  Isolate* isolate = env->isolate();

  ModuleWrap* dependent = GetFromModule(env, referrer);
  if (dependent == nullptr) {
    env->ThrowError("linking error, null dep");
    return MaybeLocal<Module>();
  }

  std::string specifier_std = ToStdString(isolate, specifier);
  if (dependent->resolve_cache_.count(specifier_std) != 1) {
    env->ThrowError("linking error, not in local cache");
    return MaybeLocal<Module>();
  }

  Local<Value> resolve_entry =
      dependent->resolve_cache_[specifier_std].Get(isolate);

  CHECK(!resolve_entry.IsEmpty());
  CHECK(resolve_entry->IsObject());

  Local<Object> module_object = resolve_entry.As<Object>();
  ModuleWrap* module;
  ASSIGN_OR_RETURN_UNWRAP(&module, module_object, MaybeLocal<Module>());
  return module->module_.Get(isolate);
}

MaybeLocal<Promise> ModuleWrap::ImportModuleDynamicallyCallback(
    Local<Context> context,
    Local<v8::ScriptOrModule> referrer,
    Local<String> specifier) {
  Isolate* isolate = context->GetIsolate();
  Environment* env = Environment::GetCurrent(context);
  CHECK_NOT_NULL(env);  // TODO(addaleax): Handle nullptr here.
  v8::EscapableHandleScope handle_scope(isolate);

  Local<PrimitiveArray> options = referrer->GetHostDefinedOptions();
  if (options->Length() != HostDefinedOptions::kLength) {
    return handle_scope.Escape(RejectWithError(context,
        v8::Exception::TypeError(FIXED_ONE_BYTE_STRING(isolate,
          "Invalid host defined options"))));
  }

  Local<Value> url = options
      ->Get(isolate, HostDefinedOptions::kURL)
      .As<Value>();

  if (url.IsEmpty())
    url = Undefined(isolate);

  Local<Object> loader;
  if (!GetModuleLoaderFromContext(context).ToLocal(&loader)) {
    return handle_scope.Escape(RejectWithError(context,
        v8::Exception::Error(FIXED_ONE_BYTE_STRING(isolate,
          "A module loader is not associated with this context"))));
  }

  Local<Value> method;
  if (!loader->Get(context, env->import_module_string()).ToLocal(&method))
    return MaybeLocal<Promise>();

  Local<Value> args[] = {
    Local<Value>(specifier),
    url,
  };

  CHECK(method->IsFunction());
  MaybeLocal<Value> result = method
      .As<Function>()
      ->Call(context, loader, arraysize(args), args);

  if (result.IsEmpty())
    return MaybeLocal<Promise>();

  Local<Value> result_val = result.ToLocalChecked();
  CHECK(result_val->IsPromise());
  return handle_scope.Escape(result_val.As<Promise>());
}

void ModuleWrap::InitializeImportMetaObjectCallback(
    Local<Context> context, Local<Module> module, Local<Object> meta) {
  Environment* env = Environment::GetCurrent(context);
  CHECK_NOT_NULL(env);  // TODO(addaleax): Handle nullptr here.

  ModuleWrap* module_wrap = GetFromModule(env, module);
  if (module_wrap == nullptr)
    return;

  Local<Object> loader;
  if (!GetModuleLoaderFromContext(context).ToLocal(&loader))
    return;

  Local<Value> method_name = env->initialize_import_meta_string();
  Local<Value> method;
  if (!loader->Get(context, method_name).ToLocal(&method))
    return;

  Local<Value> args[] = {
    meta,
    Local<String>::New(env->isolate(), module_wrap->url_),
  };

  CHECK(method->IsFunction());
  method.As<Function>()->Call(context, loader, arraysize(args), args);
}

void ModuleWrap::SetDefaultModuleLoader(
    const FunctionCallbackInfo<Value>& args) {
  Environment* env = Environment::GetCurrent(args);
  Isolate* isolate = env->isolate();
  Local<Context> context = env->context();

  CHECK_EQ(args.Length(), 1);
  CHECK(args[0]->IsObject());
  Local<Object> loader = args[0].As<Object>();

  context->SetEmbedderData(ContextEmbedderIndex::kModuleLoaderObject,
                           loader);

  isolate->SetHostInitializeImportMetaObjectCallback(
      InitializeImportMetaObjectCallback);
  isolate->SetHostImportModuleDynamicallyCallback(
      ImportModuleDynamicallyCallback);
}

void ModuleWrap::SetModuleLoaderForContext(
    const FunctionCallbackInfo<Value>& args) {
  Environment* env = Environment::GetCurrent(args);
  Isolate* isolate = env->isolate();

  CHECK_EQ(args.Length(), 2);
  Local<Context> context = ContextFromSandbox(env, args[0]);

  CHECK(args[1]->IsObject());
  Local<Object> loader = args[1].As<Object>();

  CHECK(GetModuleLoaderFromContext(context).IsEmpty());
  context->SetEmbedderData(ContextEmbedderIndex::kModuleLoaderObject,
                           loader);
}

void ModuleWrap::Initialize(Local<Object> target,
                            Local<Value> unused,
                            Local<Context> context,
                            void* priv) {
  Environment* env = Environment::GetCurrent(context);
  Isolate* isolate = env->isolate();

  Local<FunctionTemplate> tpl = env->NewFunctionTemplate(New);
  tpl->SetClassName(FIXED_ONE_BYTE_STRING(isolate, "ModuleWrap"));
  tpl->InstanceTemplate()->SetInternalFieldCount(1);

  env->SetProtoMethod(tpl, "resolveDependency", ResolveDependency);
  env->SetProtoMethod(tpl, "instantiate", Instantiate);
  env->SetProtoMethod(tpl, "evaluate", Evaluate);
  env->SetProtoMethodNoSideEffect(tpl, "getNamespace", GetNamespace);
  env->SetProtoMethodNoSideEffect(tpl, "getStatus", GetStatus);
  env->SetProtoMethodNoSideEffect(tpl, "getError", GetError);
  env->SetProtoMethodNoSideEffect(tpl, "getDependencySpecifiers",
                                  GetDependencySpecifiers);

  target->Set(env->context(), FIXED_ONE_BYTE_STRING(isolate, "ModuleWrap"),
              tpl->GetFunction(context).ToLocalChecked()).FromJust();
  env->SetMethod(target,
                 "setDefaultModuleLoader",
                 SetDefaultModuleLoader);
  env->SetMethod(target,
                 "setModuleLoaderForContext",
                 SetModuleLoaderForContext);

#define V(name)                                                                \
    target->Set(context,                                                       \
      FIXED_ONE_BYTE_STRING(env->isolate(), #name),                            \
      Integer::New(env->isolate(), Module::Status::name))                      \
        .FromJust()
    V(kUninstantiated);
    V(kInstantiating);
    V(kInstantiated);
    V(kEvaluating);
    V(kEvaluated);
    V(kErrored);
#undef V
}

}  // namespace loader
}  // namespace node

NODE_MODULE_CONTEXT_AWARE_INTERNAL(module_wrap,
                                   node::loader::ModuleWrap::Initialize)
