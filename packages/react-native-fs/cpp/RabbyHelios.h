#pragma once

#include <ReactCommon/CallInvoker.h>
#include <jsi/jsi.h>

#include <memory>
#include <string>

namespace rabbyfs {

// Installs heliosStart / heliosStop / heliosStatus / heliosRequest on the
// native FS object. Android only: Helios is linked as a separate shared
// library there.
void installHelios(
    facebook::jsi::Runtime& runtime,
    facebook::jsi::Object& nativeFs,
    std::shared_ptr<facebook::react::CallInvoker> jsCallInvoker,
    std::string cacheDirectory);

} // namespace rabbyfs
