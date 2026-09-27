import { useCallback, useEffect, useState, type ComponentProps } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ExpoRoot } from "expo-router";
import Head from "expo-router/head";
import { QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { queryClient } from "@/data/query-client";
import { I18nProvider } from "@/i18n/provider";
import { RootErrorBoundary } from "@/components/root-error-boundary";
import { renamePreRenameStorageKeys } from "@/hooks/use-settings/storage-key-rename";

// Keep Expo's platform filtering, route root, and lazy import configuration.
const { ctx: context } = require("expo-router/_ctx") as {
  ctx: ComponentProps<typeof ExpoRoot>["context"];
};

// Started at load and awaited before the router mounts: every persisted store and query reads
// storage from inside the router, so they all see the keys under their alp names.
const storageKeysRenamed = renamePreRenameStorageKeys(AsyncStorage).catch((error: unknown) => {
  console.warn("[storage] Failed to carry storage keys over from before the alp rename", error);
});

export function RootApp() {
  const [storageReady, setStorageReady] = useState(false);
  useEffect(() => {
    void storageKeysRenamed.then(() => setStorageReady(true));
  }, []);
  if (!storageReady) return null;
  return <RootRouter context={context} />;
}

export function RootRouter({ context: routes }: Pick<ComponentProps<typeof ExpoRoot>, "context">) {
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);

  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <SafeAreaProvider>
          <RootErrorBoundary key={generation} onReload={reload}>
            <Head.Provider>
              {/* Recreate the router at a safe destination before a failed route can mount. */}
              <ExpoRoot
                context={routes}
                location={generation === 0 ? undefined : "/open-project"}
              />
            </Head.Provider>
          </RootErrorBoundary>
        </SafeAreaProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
