// @electron/fuses is apps/desktop's own (bun) install, which the root does not have: what
// packaged.spec.ts reads of it, so the root's check needs no bun install. Where the package is
// installed, TypeScript resolves it and uses its own types instead of this declaration.
declare module '@electron/fuses' {
  export const FuseState: { readonly DISABLE: number, readonly ENABLE: number, readonly REMOVED: number };
  export const FuseV1Options: {
    readonly RunAsNode: number,
    readonly EnableCookieEncryption: number,
    readonly EnableNodeOptionsEnvironmentVariable: number,
    readonly EnableNodeCliInspectArguments: number,
    readonly EnableEmbeddedAsarIntegrityValidation: number,
    readonly OnlyLoadAppFromAsar: number,
  };
  export function getCurrentFuseWire(pathToElectron: string): Promise<Record<number, number>>;
}
