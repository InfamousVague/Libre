/// "Sounds" pane — pared back to just the master controls.
///
/// Pre-rework this page also rendered four cards listing every
/// achievement / progress / streak / interface cue with a per-row
/// Play button so the learner could audition each sound. The cue
/// list + previews were retired: the per-cue audition felt like
/// settings noise, and the actual cues are best discovered the way
/// every other app teaches them — by experiencing them in context.
/// The master enable toggle + the volume slider are all that
/// remains.

import { useEffect, useState } from "react";
import { volume2 } from "@base/primitives/icon/icons/volume-2";
import { volumeX } from "@base/primitives/icon/icons/volume-x";
import { sliders } from "@base/primitives/icon/icons/sliders";

import {
  getSfxSettings,
  playSound,
  setSfxSettings,
  unlockAudioContext,
} from "../../../lib/sfx";

import SettingsCard, { SettingsPage } from "./SettingsCard";
import SettingsRow from "./SettingsRow";
import SettingsToggle from "./SettingsToggle";
import { useT } from "../../../i18n/i18n";

export default function SoundPane() {
  const t = useT();
  // Mirror sfx.ts's settings cache into local React state so
  // toggling re-renders. Initialise from the cache so the first
  // paint lands on the user's persisted value rather than the
  // default flash.
  const initial = getSfxSettings();
  const [enabled, setEnabled] = useState<boolean>(initial.enabled);
  const [volume, setVolume] = useState<number>(initial.volume);

  // Cross-tab + cross-component sync. The custom event is what
  // sfx.ts dispatches on its own writes; same channel a second
  // open settings window (rare) would use to inform us.
  useEffect(() => {
    const onChanged = () => {
      const s = getSfxSettings();
      setEnabled(s.enabled);
      setVolume(s.volume);
    };
    window.addEventListener("libre:sfx:settings-changed", onChanged);
    return () =>
      window.removeEventListener("libre:sfx:settings-changed", onChanged);
  }, []);

  const onToggleEnabled = (next: boolean) => {
    setEnabled(next);
    setSfxSettings({ enabled: next });
    if (next) {
      // Warm the audio context the moment the toggle lights so
      // the FIRST cue after enabling isn't silenced by iOS
      // Safari's "no sound until a gesture" policy. Then chirp
      // a confirmation ping the same way the master toggle did
      // pre-rewrite.
      void unlockAudioContext();
      playSound("ping", { ignoreMute: true });
    }
  };

  const onVolume = (v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolume(clamped);
    setSfxSettings({ volume: clamped });
  };

  return (
    <SettingsPage
      title={t("settings.soundsTitle")}
      description={t("settings.soundsDescription")}
    >
      <SettingsCard title={t("settings.masterCard")}>
        <SettingsRow
          icon={enabled ? volume2 : volumeX}
          tone={enabled ? "accent" : "default"}
          label={t("settings.soundEffects")}
          sub={t("settings.soundEffectsSub")}
          control={
            <SettingsToggle
              checked={enabled}
              onChange={onToggleEnabled}
              label={t("settings.soundEffects")}
            />
          }
        />
        <SettingsRow
          icon={sliders}
          label={t("settings.volumeLabel")}
          sub={t("settings.volumeSub", { percent: Math.round(volume * 100) })}
          control={
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => onVolume(Number.parseFloat(e.target.value))}
              aria-label={t("settings.volumeAria")}
              disabled={!enabled}
              className="libre-settings-cue-slider"
            />
          }
        />
      </SettingsCard>
    </SettingsPage>
  );
}
