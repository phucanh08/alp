# @anhlp/alp

The `alp` command of [ALP](https://github.com/phucanh08/alp) for npm users. This package is a
thin wrapper: it depends on `@anhlp/alp-cli` (pinned to the same version) and its `alp` runs that
CLI on your Node (22.12 or later). Nothing is downloaded after install.

```sh
npm install -g @anhlp/alp@beta
alp --version
```

Update an npm install with npm (`npm install -g @anhlp/alp@beta`); `alp update` updates only the
ALP bundle installed from [GitHub Releases](https://github.com/phucanh08/alp/releases) with
`install.sh` (`install.ps1` on Windows), which brings its own Node.

The libraries (`@anhlp/alp-core`, `-protocol`, `-runtime`, `-client`, `-daemon`, `-cli`) and the
Paseo plugin (`@anhlp/alp-paseo`) are JavaScript packages too.

Apache-2.0; see LICENSE and NOTICE.
