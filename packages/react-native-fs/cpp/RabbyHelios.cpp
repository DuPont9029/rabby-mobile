// Android only (Helios is not linked on iOS).
#ifdef __ANDROID__
#include "RabbyHelios.h"

#include <rabby_helios.h>

#include <atomic>
#include <memory>
#include <string>
#include <thread>
#include <utility>

namespace rabbyfs {

using namespace facebook;

namespace {

// Requests block on the network; cap the threads parked on them.
constexpr int kMaxInFlightRequests = 8;
constexpr size_t kMaxRequestBytes = 256 * 1024;

std::string takeString(char* value) {
  if (value == nullptr) {
    return std::string();
  }
  std::string copy(value);
  rabby_helios_free_string(value);
  return copy;
}

struct Callbacks {
  Callbacks(jsi::Function resolveValue, jsi::Function rejectValue)
      : resolve(std::move(resolveValue)), reject(std::move(rejectValue)) {}
  jsi::Function resolve;
  jsi::Function reject;
};

std::string requireString(
    jsi::Runtime& runtime,
    const jsi::Value* arguments,
    size_t count,
    const char* name) {
  if (count < 1 || !arguments[0].isString()) {
    throw jsi::JSError(runtime, std::string(name) + " expects a string");
  }
  return arguments[0].asString(runtime).utf8(runtime);
}

} // namespace

void installHelios(
    jsi::Runtime& runtime,
    jsi::Object& nativeFs,
    std::shared_ptr<react::CallInvoker> jsCallInvoker,
    std::string cacheDirectory) {
  if (!jsCallInvoker || cacheDirectory.empty()) {
    return;
  }
  auto inFlight = std::make_shared<std::atomic<int>>(0);
  const std::string dataDirectory = cacheDirectory + "/helios-mainnet";

  nativeFs.setProperty(
      runtime,
      "heliosDataDirectory",
      jsi::String::createFromUtf8(runtime, dataDirectory));

  nativeFs.setProperty(
      runtime,
      "heliosStart",
      jsi::Function::createFromHostFunction(
          runtime,
          jsi::PropNameID::forAscii(runtime, "heliosStart"),
          1,
          [](jsi::Runtime& runtime,
             const jsi::Value&,
             const jsi::Value* arguments,
             size_t count) -> jsi::Value {
            const auto config =
                requireString(runtime, arguments, count, "heliosStart");
            return jsi::Value(rabby_helios_start(config.c_str()));
          }));

  nativeFs.setProperty(
      runtime,
      "heliosStop",
      jsi::Function::createFromHostFunction(
          runtime,
          jsi::PropNameID::forAscii(runtime, "heliosStop"),
          0,
          [](jsi::Runtime&, const jsi::Value&, const jsi::Value*, size_t)
              -> jsi::Value {
            rabby_helios_stop();
            return jsi::Value::undefined();
          }));

  nativeFs.setProperty(
      runtime,
      "heliosStatus",
      jsi::Function::createFromHostFunction(
          runtime,
          jsi::PropNameID::forAscii(runtime, "heliosStatus"),
          0,
          [](jsi::Runtime& runtime, const jsi::Value&, const jsi::Value*, size_t)
              -> jsi::Value {
            return jsi::String::createFromUtf8(
                runtime, takeString(rabby_helios_status()));
          }));

  nativeFs.setProperty(
      runtime,
      "heliosRequest",
      jsi::Function::createFromHostFunction(
          runtime,
          jsi::PropNameID::forAscii(runtime, "heliosRequest"),
          1,
          [jsCallInvoker, inFlight](
              jsi::Runtime& runtime,
              const jsi::Value&,
              const jsi::Value* arguments,
              size_t count) -> jsi::Value {
            auto request =
                requireString(runtime, arguments, count, "heliosRequest");
            if (request.size() > kMaxRequestBytes) {
              throw jsi::JSError(runtime, "heliosRequest: request too large");
            }
            auto promiseConstructor =
                runtime.global().getPropertyAsFunction(runtime, "Promise");
            auto executor = jsi::Function::createFromHostFunction(
                runtime,
                jsi::PropNameID::forAscii(runtime, "heliosRequestExecutor"),
                2,
                [jsCallInvoker, inFlight, request = std::move(request)](
                    jsi::Runtime& runtime,
                    const jsi::Value&,
                    const jsi::Value* arguments,
                    size_t count) mutable -> jsi::Value {
                  if (count < 2 || !arguments[0].isObject() ||
                      !arguments[1].isObject()) {
                    throw jsi::JSError(
                        runtime, "heliosRequest Promise executor is invalid");
                  }
                  auto callbacks = std::make_shared<Callbacks>(
                      arguments[0].asObject(runtime).asFunction(runtime),
                      arguments[1].asObject(runtime).asFunction(runtime));
                  if (inFlight->fetch_add(1) >= kMaxInFlightRequests) {
                    inFlight->fetch_sub(1);
                    callbacks->reject.call(
                        runtime,
                        jsi::String::createFromAscii(
                            runtime, "helios: too many requests in flight"));
                    return jsi::Value::undefined();
                  }
                  std::thread([jsCallInvoker,
                               inFlight,
                               callbacks,
                               request = std::move(request)] {
                    auto response =
                        takeString(rabby_helios_request(request.c_str()));
                    inFlight->fetch_sub(1);
                    jsCallInvoker->invokeAsync(
                        [callbacks, response = std::move(response)](
                            jsi::Runtime& runtime) {
                          callbacks->resolve.call(
                              runtime,
                              jsi::String::createFromUtf8(runtime, response));
                        });
                  }).detach();
                  return jsi::Value::undefined();
                });
            return promiseConstructor.callAsConstructor(
                runtime, std::move(executor));
          }));
}

} // namespace rabbyfs

#endif // __ANDROID__
