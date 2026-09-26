import { useCallback, useMemo, useState } from "react";
import { Pressable, Text } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Crown, MessageCircle } from "lucide-react-native";
import { composerPillStyles } from "@/composer/pill-styles";
import type { Theme } from "@/styles/theme";
import type { DraftSeat } from "./slp-seat";

const ThemedCrownIcon = withUnistyles(Crown);
const ThemedMessageCircleIcon = withUnistyles(MessageCircle);
const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface ComposerSlpSeatPillProps {
  seat: DraftSeat;
  disabled: boolean;
  onChange: (seat: DraftSeat) => void;
}

/** Two states, so a press flips the seat; the label always names the seat the draft will ask for. */
export function ComposerSlpSeatPill({ seat, disabled, onChange }: ComposerSlpSeatPillProps) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);
  const nextSeat: DraftSeat = seat === "lead" ? "chat" : "lead";
  const handlePress = useCallback(() => onChange(nextSeat), [nextSeat, onChange]);
  const isActive = isHovered && !disabled;
  const bodyStyle = useMemo(
    () => [
      composerPillStyles.body,
      isActive && composerPillStyles.bodyActive,
      disabled && styles.disabled,
    ],
    [disabled, isActive],
  );
  const labelStyle = useMemo(
    () => [composerPillStyles.label, isActive && composerPillStyles.labelActive],
    [isActive],
  );
  const label = seat === "lead" ? t("composer.slpSeat.lead") : t("composer.slpSeat.chat");
  const switchLabel =
    nextSeat === "lead" ? t("composer.slpSeat.switchToLead") : t("composer.slpSeat.switchToChat");
  return (
    <Pressable
      testID="composer-slp-seat-pill"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={switchLabel}
      onPress={handlePress}
      disabled={disabled}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={bodyStyle}
    >
      {seat === "lead" ? (
        <ThemedCrownIcon size={14} uniProps={iconColorMapping} />
      ) : (
        <ThemedMessageCircleIcon size={14} uniProps={iconColorMapping} />
      )}
      <Text style={labelStyle} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  disabled: {
    opacity: theme.opacity[50],
  },
}));
