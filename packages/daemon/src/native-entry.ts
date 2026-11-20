// Entry of the native alpd (t-81b0.9): `bun build --compile` of this file is `<bundle>/bin/alpd`
// (scripts/build-alpd-native.mjs). The registration must load before alpd: ES modules evaluate in
// import order.
import './native-register.js';
import './main.js';
