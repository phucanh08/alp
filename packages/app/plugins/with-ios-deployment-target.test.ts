import { describe, expect, it } from "vitest";

const {
  configureDeploymentTargetBuildConfigurations,
  configureDeploymentTargetPodfile,
} = require("./with-ios-deployment-target");

// The post_install block of the Expo SDK 54 Podfile template.
const PODFILE = [
  "  post_install do |installer|",
  "    react_native_post_install(",
  "      installer,",
  "      config[:reactNativePath],",
  "      :mac_catalyst_enabled => false,",
  "      :ccache_enabled => ccache_enabled?(podfile_properties),",
  "    )",
  "  end",
  "end",
  "",
].join("\n");

describe("withIosDeploymentTarget", () => {
  it("raises every pod after React Native sets its own minimum", () => {
    const configured = configureDeploymentTargetPodfile(PODFILE, "17.0");

    expect(configured).toContain("([installer.pods_project] + installer.pods_project.targets)");
    expect(configured).toContain("Gem::Version.new('17.0')");
    expect(configured).toContain("config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '17.0'");
    expect(configured.indexOf("Gem::Version.new('17.0')")).toBeGreaterThan(
      configured.indexOf(":ccache_enabled => ccache_enabled?(podfile_properties),\n    )"),
    );
    expect(configured.endsWith("  end\nend\n")).toBe(true);
    expect(configureDeploymentTargetPodfile(configured, "17.0")).toBe(configured);
  });

  it("fails loudly when the Podfile has no React Native post_install", () => {
    expect(() => configureDeploymentTargetPodfile("platform :ios, '15.1'\n", "17.0")).toThrow(
      "Could not raise the pods to the iOS deployment target",
    );
  });

  it("raises the Xcode project and target settings that are below the minimum", () => {
    const configurations = {
      project_debug: {
        isa: "XCBuildConfiguration",
        buildSettings: { IPHONEOS_DEPLOYMENT_TARGET: "15.1" },
        name: "Debug",
      },
      project_debug_comment: "Debug",
      target_release: {
        isa: "XCBuildConfiguration",
        buildSettings: { IPHONEOS_DEPLOYMENT_TARGET: "17.0", PRODUCT_NAME: "alp" },
        name: "Release",
      },
      newer: {
        isa: "XCBuildConfiguration",
        buildSettings: { IPHONEOS_DEPLOYMENT_TARGET: "18.2" },
        name: "Release",
      },
      unset: { isa: "XCBuildConfiguration", buildSettings: {}, name: "Debug" },
    };

    configureDeploymentTargetBuildConfigurations(configurations, "17.0");

    expect(configurations).toEqual({
      project_debug: {
        isa: "XCBuildConfiguration",
        buildSettings: { IPHONEOS_DEPLOYMENT_TARGET: "17.0" },
        name: "Debug",
      },
      project_debug_comment: "Debug",
      target_release: {
        isa: "XCBuildConfiguration",
        buildSettings: { IPHONEOS_DEPLOYMENT_TARGET: "17.0", PRODUCT_NAME: "alp" },
        name: "Release",
      },
      newer: {
        isa: "XCBuildConfiguration",
        buildSettings: { IPHONEOS_DEPLOYMENT_TARGET: "18.2" },
        name: "Release",
      },
      unset: { isa: "XCBuildConfiguration", buildSettings: {}, name: "Debug" },
    });
  });
});
