# @anhlp/alp

The `alp` command of [ALP](https://github.com/phucanh08/alp). This package is a small launcher:
npm installs the ALP executable for your machine as one optional dependency,
`@anhlp/alp-<os>-<arch>` (darwin-arm64, darwin-x64, linux-x64, linux-arm64 (glibc), win32-x64),
and `alp` runs it with your arguments. Nothing is downloaded after install.

```sh
npm install -g @anhlp/alp@beta
alp --version
```

If `alp` says the executable for this machine is not installed, npm skipped optional
dependencies (`--omit=optional`): reinstall with `--include=optional`, or install the executable
directly from [GitHub Releases](https://github.com/phucanh08/alp/releases) with `install.sh`
(`install.ps1` on Windows). Update an npm install with npm (`npm install -g @anhlp/alp@beta`);
`alp update` updates only an executable installed from GitHub Releases.

The libraries (`@anhlp/alp-core`, `-protocol`, `-runtime`, `-client`, `-daemon`, `-cli`) and the
Paseo plugin (`@anhlp/alp-paseo`) stay JavaScript packages.

Apache-2.0; see LICENSE and NOTICE.
