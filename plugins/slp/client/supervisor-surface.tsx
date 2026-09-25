import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { openSupervisor } from "./ensure-supervisor";
import { ensureSupervisorRpc } from "./supervisor-rpc";

type OpenStatus =
  | { readonly kind: "opening" }
  | { readonly kind: "opened" }
  | { readonly kind: "failed"; readonly message: string };

const ACTION_LABELS: Record<OpenStatus["kind"], string> = {
  opening: "Opening...",
  opened: "Open",
  failed: "Try again",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Target of the Supervisor sidebar item. Opening the item ensures the Supervisor on the selected
 * host and navigates straight to its agent. The row stays so a return visit can reopen or retry.
 */
export function SupervisorSurface({ theme, layout, navigation }: PluginSurfaceProps) {
  const ensure = useRpc(ensureSupervisorRpc);
  const [status, setStatus] = useState<OpenStatus>({ kind: "opening" });
  const mounted = useRef(true);
  const started = useRef(false);

  const open = useCallback(async () => {
    if (!navigation) return;
    setStatus({ kind: "opening" });
    try {
      await openSupervisor({
        ensure: () => ensure({}),
        openAgent: (target) => navigation.openAgent(target),
      });
      if (mounted.current) setStatus({ kind: "opened" });
    } catch (error) {
      if (mounted.current) setStatus({ kind: "failed", message: errorMessage(error) });
    }
  }, [ensure, navigation]);
  const onPressOpen = useCallback(() => {
    void open();
  }, [open]);

  useEffect(() => {
    mounted.current = true;
    if (!started.current) {
      started.current = true;
      void open();
    }
    return () => {
      mounted.current = false;
    };
  }, [open]);

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
    }),
    [theme, layout.compact],
  );

  if (!navigation) {
    return (
      <View style={styles.screen}>
        <SettingsCard>
          <SettingsAction
            label="Supervisor"
            hint="Update the app to open the Supervisor from here"
            actionLabel="Open"
            onPress={onPressOpen}
            disabled
          />
        </SettingsCard>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <SettingsCard>
        <SettingsAction
          label="Supervisor"
          hint={status.kind === "opening" ? "Opening Supervisor..." : undefined}
          error={status.kind === "failed" ? `Unable to open Supervisor: ${status.message}` : null}
          actionLabel={ACTION_LABELS[status.kind]}
          onPress={onPressOpen}
          disabled={status.kind === "opening"}
          testID="slp-supervisor-open"
        />
      </SettingsCard>
    </View>
  );
}
