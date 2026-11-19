// macOS 原生窗口行为补丁：把 Electron 窗口调整成 Gold Monitor 同款 borderless panel。
// Electron 没有公开 NSWindowCollectionBehaviorStationary，也没有暴露清理 styleMask 的能力。
#include <node_api.h>
#import <Cocoa/Cocoa.h>
#include <cstdint>

static napi_value ApplyWidgetBehavior(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  void* raw = nullptr;
  size_t length = 0;
  if (argc < 1 || napi_get_buffer_info(env, argv[0], &raw, &length) != napi_ok ||
      !raw || length < sizeof(void*)) {
    napi_throw_type_error(env, nullptr, "expected native window handle Buffer");
    return nullptr;
  }
  bool floating = false;
  if (argc >= 2) napi_get_value_bool(env, argv[1], &floating);

  uintptr_t windowPtr = *reinterpret_cast<uintptr_t*>(raw);
  NSView* view = (__bridge NSView*)(void*)windowPtr;
  NSWindow* window = view.window;
  napi_value result;
  napi_create_object(env, &result);
  if (!window) return result;

  NSWindowCollectionBehavior before = window.collectionBehavior;
  // Gold Monitor: canJoinAllSpaces + fullScreenAuxiliary + stationary。
  // 清掉 Electron 额外加的 managed/transient 位，避免系统在桌面切换时重新接管窗口。
  NSWindowCollectionBehavior wanted =
      (before & ~NSWindowCollectionBehaviorManaged & ~NSWindowCollectionBehaviorTransient) |
      NSWindowCollectionBehaviorCanJoinAllSpaces |
      NSWindowCollectionBehaviorFullScreenAuxiliary |
      NSWindowCollectionBehaviorStationary;
  window.collectionBehavior = wanted;

  // Electron type='panel' 默认 styleMask=143；Gold Monitor 使用纯 borderless。
  window.styleMask = NSWindowStyleMaskBorderless;
  window.level = floating ? NSFloatingWindowLevel : NSNormalWindowLevel;
  window.hasShadow = YES;
  window.hidesOnDeactivate = NO;
  window.acceptsMouseMovedEvents = YES;
  window.releasedWhenClosed = NO;
  window.movableByWindowBackground = YES;
  window.animationBehavior = NSWindowAnimationBehaviorUtilityWindow;
  window.ignoresMouseEvents = NO;

  napi_value beforeValue, afterValue, styleValue, levelValue;
  napi_create_int64(env, (int64_t)before, &beforeValue);
  napi_create_int64(env, (int64_t)window.collectionBehavior, &afterValue);
  napi_create_int64(env, (int64_t)window.styleMask, &styleValue);
  napi_create_int64(env, (int64_t)window.level, &levelValue);
  napi_set_named_property(env, result, "before", beforeValue);
  napi_set_named_property(env, result, "after", afterValue);
  napi_set_named_property(env, result, "styleMask", styleValue);
  napi_set_named_property(env, result, "level", levelValue);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "applyWidgetBehavior", NAPI_AUTO_LENGTH, ApplyWidgetBehavior, nullptr, &fn);
  napi_set_named_property(env, exports, "applyWidgetBehavior", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
