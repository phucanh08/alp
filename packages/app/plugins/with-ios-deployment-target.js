const { withPodfile, withXcodeProject } = require("expo/config-plugins");

// expo-build-properties sets the app target and the Podfile platform, but each pod keeps the
// minimum iOS its podspec declares (SDWebImage 9.0), and react_native_post_install only raises pods
// to React Native's own minimum. Xcode 27 rejects pods below iOS 15, and resource bundle targets
// like RNSVGFilters are not raised by React Native at all. This raises the whole Pods project and
// the app project's remaining configurations to the app's minimum.
const REACT_NATIVE_POST_INSTALL_END =
  "      :ccache_enabled => ccache_enabled?(podfile_properties),\n    )\n";
const PODFILE_MARKER = "    # Build every pod for the app's minimum iOS";

function podfileDeploymentTargetHook(deploymentTarget) {
  return [
    PODFILE_MARKER,
    "    ([installer.pods_project] + installer.pods_project.targets).each do |item|",
    "      item.build_configurations.each do |config|",
    "        current = config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']",
    `        next if current && Gem::Version.new(current) >= Gem::Version.new('${deploymentTarget}')`,
    `        config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${deploymentTarget}'`,
    "      end",
    "    end",
    "",
  ].join("\n");
}

function configureDeploymentTargetPodfile(contents, deploymentTarget) {
  if (contents.includes(PODFILE_MARKER)) {
    return contents;
  }
  if (!contents.includes(REACT_NATIVE_POST_INSTALL_END)) {
    throw new Error("Could not raise the pods to the iOS deployment target");
  }
  return contents.replace(
    REACT_NATIVE_POST_INSTALL_END,
    `${REACT_NATIVE_POST_INSTALL_END}${podfileDeploymentTargetHook(deploymentTarget)}`,
  );
}

function isBelow(version, minimum) {
  const current = version.split(".").map(Number);
  const target = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(current.length, target.length); index += 1) {
    const difference = (current[index] ?? 0) - (target[index] ?? 0);
    if (difference !== 0) {
      return difference < 0;
    }
  }
  return false;
}

function configureDeploymentTargetBuildConfigurations(configurations, deploymentTarget) {
  for (const configuration of Object.values(configurations)) {
    const current = configuration?.buildSettings?.IPHONEOS_DEPLOYMENT_TARGET;
    if (current && isBelow(String(current).replaceAll('"', ""), deploymentTarget)) {
      configuration.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = deploymentTarget;
    }
  }
  return configurations;
}

function withIosDeploymentTarget(config, { deploymentTarget } = {}) {
  if (!deploymentTarget) {
    throw new Error("withIosDeploymentTarget needs a deploymentTarget");
  }
  const withProject = withXcodeProject(config, (modConfig) => {
    configureDeploymentTargetBuildConfigurations(
      modConfig.modResults.pbxXCBuildConfigurationSection(),
      deploymentTarget,
    );
    return modConfig;
  });
  return withPodfile(withProject, (modConfig) => {
    modConfig.modResults.contents = configureDeploymentTargetPodfile(
      modConfig.modResults.contents,
      deploymentTarget,
    );
    return modConfig;
  });
}

module.exports = withIosDeploymentTarget;
module.exports.configureDeploymentTargetPodfile = configureDeploymentTargetPodfile;
module.exports.configureDeploymentTargetBuildConfigurations =
  configureDeploymentTargetBuildConfigurations;
