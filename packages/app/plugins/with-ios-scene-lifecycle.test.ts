import { describe, expect, it } from "vitest";

const {
  configureSceneLifecycleAppDelegate,
  configureSceneManifest,
} = require("./with-ios-scene-lifecycle");
const { configurePasteInputAppDelegate } = require("./with-paste-input");

// The Expo SDK 54 template, as `expo prebuild` generates it.
const TEMPLATE = [
  "import Expo",
  "import React",
  "import ReactAppDependencyProvider",
  "",
  "@UIApplicationMain",
  "public class AppDelegate: ExpoAppDelegate {",
  "  var window: UIWindow?",
  "",
  "  public override func application(",
  "    _ application: UIApplication,",
  "    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil",
  "  ) -> Bool {",
  "    let delegate = ReactNativeDelegate()",
  "    let factory = ExpoReactNativeFactory(delegate: delegate)",
  "    bindReactNativeFactory(factory)",
  "",
  "#if os(iOS) || os(tvOS)",
  "    window = UIWindow(frame: UIScreen.main.bounds)",
  "    factory.startReactNative(",
  '      withModuleName: "main",',
  "      in: window,",
  "      launchOptions: launchOptions)",
  "#endif",
  "",
  "    return super.application(application, didFinishLaunchingWithOptions: launchOptions)",
  "  }",
  "}",
  "",
].join("\n");

describe("withIosSceneLifecycle", () => {
  it("defers launch until the scene delegate has a window from the window scene", () => {
    const configured = configureSceneLifecycleAppDelegate(TEMPLATE);

    expect(configured).not.toContain("UIWindow(frame: UIScreen.main.bounds)");
    expect(configured).toContain(
      "  ) -> Bool {\n    guard window != nil else { return true }\n    let delegate = ReactNativeDelegate()",
    );
    expect(configured).toContain("class SceneDelegate: UIResponder, UIWindowSceneDelegate {");
    expect(configured).toContain("let window = UIWindow(windowScene: windowScene)");
    expect(configured).toContain(
      "appDelegate.application(application, didFinishLaunchingWithOptions: launchOptions)",
    );
    expect(configureSceneLifecycleAppDelegate(configured)).toBe(configured);
  });

  it("keeps paste input setup after React Native starts whichever plugin runs first", () => {
    const sceneFirst = configurePasteInputAppDelegate(configureSceneLifecycleAppDelegate(TEMPLATE));
    const pasteFirst = configureSceneLifecycleAppDelegate(configurePasteInputAppDelegate(TEMPLATE));

    expect(sceneFirst).toBe(pasteFirst);
    expect(sceneFirst).toContain(
      "      launchOptions: launchOptions)\n    PasteInputModule.setup(factory.rootViewFactory)\n#endif",
    );
  });

  it("hands cold-start links to React Native as launch options and through the app delegate", () => {
    const configured = configureSceneLifecycleAppDelegate(TEMPLATE);

    expect(configured).toContain('rawValue: "UIApplicationLaunchOptionsURLKey"');
    expect(configured).toContain('rawValue: "UIApplicationLaunchOptionsUserActivityDictionaryKey"');
    expect(configured).toContain("func scene(_ scene: UIScene, openURLContexts URLContexts:");
    expect(configured).toContain(
      "func scene(_ scene: UIScene, continue userActivity: NSUserActivity)",
    );
  });

  it("fails loudly when the template no longer creates the window at launch", () => {
    expect(() =>
      configureSceneLifecycleAppDelegate(
        TEMPLATE.replace("    window = UIWindow(frame: UIScreen.main.bounds)\n", ""),
      ),
    ).toThrow("Could not move window creation to the scene delegate");
  });

  it("declares a single window scene backed by the app's SceneDelegate", () => {
    const configured = configureSceneManifest({ CFBundleName: "$(PRODUCT_NAME)" });

    expect(configured).toEqual({
      CFBundleName: "$(PRODUCT_NAME)",
      UIApplicationSceneManifest: {
        UIApplicationSupportsMultipleScenes: false,
        UISceneConfigurations: {
          UIWindowSceneSessionRoleApplication: [
            {
              UISceneConfigurationName: "Default Configuration",
              UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
            },
          ],
        },
      },
    });
  });
});
