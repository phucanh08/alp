const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

// Apps built with the iOS 27 SDK refuse to launch without the UIScene life cycle. Expo SDK 54 has
// no scene delegate, so this adds one. A window only renders once it belongs to a UIWindowScene,
// and UIKit creates the scene after application(_:didFinishLaunchingWithOptions:) returns. So that
// call now returns early, and SceneDelegate calls it again with the scene's window. The launch body
// then runs unchanged and in its original order: React Native starts, lines other plugins add
// after it (paste input needs the React host) run, and super runs the Expo subscribers, which
// expo-dev-launcher needs to happen after React Native starts.
const LAUNCH_BODY_START = "  ) -> Bool {\n    let delegate = ReactNativeDelegate()";
const DEFER_LAUNCH = "    guard window != nil else { return true }";
const WINDOW_CREATION = "    window = UIWindow(frame: UIScreen.main.bounds)\n";
const SCENE_DELEGATE_MARKER = "// UIScene life cycle: owns the window";

// Appended to AppDelegate.swift so it lands in the app module without editing the Xcode project.
const SCENE_DELEGATE = `
${SCENE_DELEGATE_MARKER} and replays launch, links and life cycle events to AppDelegate.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
      return
    }
    let application = UIApplication.shared
    let window = UIWindow(windowScene: windowScene)
    self.window = window

    if let rootViewController = appDelegate.window?.rootViewController {
      // UIKit discarded the scene while the app kept running: React Native is already up.
      appDelegate.window?.rootViewController = nil
      window.rootViewController = rootViewController
      appDelegate.window = window
      window.makeKeyAndVisible()
    } else {
      appDelegate.window = window
      let launchOptions = Self.launchOptions(from: connectionOptions)
      _ = appDelegate.application(application, didFinishLaunchingWithOptions: launchOptions)
    }

    for context in connectionOptions.urlContexts {
      _ = appDelegate.application(application, open: context.url, options: Self.openURLOptions(from: context.options))
    }
    for userActivity in connectionOptions.userActivities {
      _ = appDelegate.application(application, continue: userActivity, restorationHandler: { _ in })
    }
  }

  func sceneDidDisconnect(_ scene: UIScene) {
    window = nil
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    for context in URLContexts {
      _ = appDelegate.application(UIApplication.shared, open: context.url, options: Self.openURLOptions(from: context.options))
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    _ = appDelegate.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.applicationDidBecomeActive(UIApplication.shared)
  }

  func sceneWillResignActive(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.applicationWillResignActive(UIApplication.shared)
  }

  func sceneWillEnterForeground(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.applicationWillEnterForeground(UIApplication.shared)
  }

  func sceneDidEnterBackground(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.applicationDidEnterBackground(UIApplication.shared)
  }

  // React Native's Linking.getInitialURL() reads the cold-start link from the launch options, but
  // UIKit now delivers it in the connection options. The keys are spelled out because their
  // UIApplication accessors are deprecated in favor of the scene APIs.
  private static func launchOptions(
    from connectionOptions: UIScene.ConnectionOptions
  ) -> [UIApplication.LaunchOptionsKey: Any]? {
    var launchOptions: [UIApplication.LaunchOptionsKey: Any] = [:]
    if let url = connectionOptions.urlContexts.first?.url {
      launchOptions[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsURLKey")] = url
    }
    if let userActivity = connectionOptions.userActivities.first(where: { $0.activityType == NSUserActivityTypeBrowsingWeb }) {
      launchOptions[UIApplication.LaunchOptionsKey(rawValue: "UIApplicationLaunchOptionsUserActivityDictionaryKey")] = [
        "UIApplicationLaunchOptionsUserActivityTypeKey": userActivity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": userActivity,
      ]
    }
    return launchOptions.isEmpty ? nil : launchOptions
  }

  private static func openURLOptions(
    from sceneOptions: UIScene.OpenURLOptions
  ) -> [UIApplication.OpenURLOptionsKey: Any] {
    var options: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: sceneOptions.openInPlace]
    if let sourceApplication = sceneOptions.sourceApplication {
      options[.sourceApplication] = sourceApplication
    }
    if let annotation = sceneOptions.annotation {
      options[.annotation] = annotation
    }
    return options
  }
}
`;

function configureSceneLifecycleAppDelegate(contents) {
  if (contents.includes(SCENE_DELEGATE_MARKER)) {
    return contents;
  }
  if (!contents.includes(LAUNCH_BODY_START)) {
    throw new Error("Could not defer launch to the scene delegate");
  }
  if (!contents.includes(WINDOW_CREATION)) {
    throw new Error("Could not move window creation to the scene delegate");
  }
  const configured = contents
    .replace(
      LAUNCH_BODY_START,
      `  ) -> Bool {\n${DEFER_LAUNCH}\n    let delegate = ReactNativeDelegate()`,
    )
    .replace(WINDOW_CREATION, "");
  return `${configured.trimEnd()}\n${SCENE_DELEGATE}`;
}

function configureSceneManifest(infoPlist) {
  return {
    ...infoPlist,
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
  };
}

function withIosSceneLifecycle(config) {
  const withDelegate = withAppDelegate(config, (modConfig) => {
    if (modConfig.modResults.language !== "swift") {
      throw new Error("The UIScene life cycle setup requires a Swift AppDelegate");
    }
    modConfig.modResults.contents = configureSceneLifecycleAppDelegate(
      modConfig.modResults.contents,
    );
    return modConfig;
  });
  return withInfoPlist(withDelegate, (modConfig) => {
    modConfig.modResults = configureSceneManifest(modConfig.modResults);
    return modConfig;
  });
}

module.exports = withIosSceneLifecycle;
module.exports.configureSceneLifecycleAppDelegate = configureSceneLifecycleAppDelegate;
module.exports.configureSceneManifest = configureSceneManifest;
