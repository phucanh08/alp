import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@/components/settings";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useSlpSettings, type SlpSettings } from "@/plugins/slp-settings/use-slp-settings";
import { filterSelectableModels } from "@/provider-selection/model-catalog";

// The slp plugin seats its Supervisor on claude (`seatProfileFor` in plugins/slp/server/ensure.ts)
// and honors `supervisorModel` only when it names one of that provider's selectable model ids.
const SUPERVISOR_PROVIDER = "claude";
// Model ids are never empty, so the empty string stands for the stored `null`.
const DEFAULT_MODEL_OPTION = "";

type ReadySlpSettings = Extract<SlpSettings, { status: "ready" }>;
type SavedField = "enabled" | "supervisorModel";

interface ModelOption {
  label: string;
  value: string;
}

function useSupervisorModelOptions(serverId: string): ModelOption[] {
  const { t } = useTranslation();
  const { entries } = useProvidersSnapshot(serverId);
  return useMemo(() => {
    const entry = entries?.find((candidate) => candidate.provider === SUPERVISOR_PROVIDER);
    const models = filterSelectableModels(entry?.models ?? null) ?? [];
    const defaultOption = {
      label: t("settings.host.slp.supervisorModel.default"),
      value: DEFAULT_MODEL_OPTION,
    };
    return [defaultOption, ...models.map((model) => ({ label: model.label, value: model.id }))];
  }, [entries, t]);
}

function SlpSettingsRows({ serverId, slp }: { serverId: string; slp: ReadySlpSettings }) {
  const { t } = useTranslation();
  const options = useSupervisorModelOptions(serverId);
  const [savedField, setSavedField] = useState<SavedField>("enabled");
  const { save } = slp;

  const changeEnabled = useCallback(
    (enabled: boolean) => {
      setSavedField("enabled");
      void save({ enabled });
    },
    [save],
  );
  const changeSupervisorModel = useCallback(
    (value: string) => {
      setSavedField("supervisorModel");
      void save({ supervisorModel: value === DEFAULT_MODEL_OPTION ? null : value });
    },
    [save],
  );

  return (
    <SettingsCard>
      <SettingsSwitch
        label={t("settings.host.slp.enabled.label")}
        hint={t("settings.host.slp.enabled.hint")}
        error={savedField === "enabled" ? slp.saveError : null}
        value={slp.enabled}
        disabled={slp.saving}
        onValueChange={changeEnabled}
      />
      <SettingsSelect
        label={t("settings.host.slp.supervisorModel.label")}
        hint={t("settings.host.slp.supervisorModel.hint")}
        error={savedField === "supervisorModel" ? slp.saveError : null}
        value={slp.supervisorModel ?? DEFAULT_MODEL_OPTION}
        options={options}
        disabled={slp.saving}
        onValueChange={changeSupervisorModel}
      />
    </SettingsCard>
  );
}

/** Host-scoped SLP settings. Renders nothing on a host that runs no slp plugin. */
export function SlpSettingsCard({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const slp = useSlpSettings(serverId);
  if (slp.status === "unavailable") return null;
  return (
    <SettingsSection title={t("settings.host.slp.title")}>
      {slp.status === "ready" ? (
        <SlpSettingsRows serverId={serverId} slp={slp} />
      ) : (
        <SettingsCard>
          <SettingsRow
            label={t("settings.host.slp.enabled.label")}
            hint={slp.status === "loading" ? t("settings.host.slp.loading") : undefined}
            error={slp.status === "error" ? slp.error : null}
          />
        </SettingsCard>
      )}
    </SettingsSection>
  );
}
