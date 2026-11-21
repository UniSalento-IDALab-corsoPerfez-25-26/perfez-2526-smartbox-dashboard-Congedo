// GENERATO da tools/genera_config_js.py a partire da config.yaml: non modificare a mano (D-48).
export const DEFAULT_CONFIG = {
  "video": {
    "face_lost_seconds": 5
  },
  "detector": {
    "min_detection_confidence": 0.5,
    "min_tracking_confidence": 0.5
  },
  "indicators": {
    "ear_closed_threshold": 0.21,
    "mar_yawn_threshold": 0.5,
    "eye_closure_source": "blendshape",
    "blink_closed_threshold": 0.6,
    "blink_squint_margin": 0.25,
    "pitch_nod_threshold": 20.0,
    "pitch_baseline": 0.0,
    "window_seconds": 60
  },
  "alarm": {
    "perclos_warning": 0.15,
    "perclos_danger": 0.3,
    "perclos_min_seconds": 55,
    "microsleep_seconds": 1.5,
    "yawns_per_window_warning": 3,
    "yawn_min_seconds": 1.0,
    "yawn_opening_fraction": 0.5,
    "yawn_masks_eye_closure": true,
    "yawn_eye_grace_seconds": 2.5,
    "nod_seconds": 1.0,
    "nod_lost_fraction": 0.7,
    "hysteresis_seconds": 5,
    "min_seconds_between_alerts": 10,
    "gradual_descent": true
  },
  "calibration": {
    "fraction": 0.8,
    "min_gap": 0.15,
    "ear_distinct_ratio": 0.85,
    "min_open_samples": 20,
    "min_closed_samples": 10,
    "ear_limits": [
      0.08,
      0.27
    ],
    "blink_limits": [
      0.3,
      0.85
    ],
    "margin_limits": [
      -0.3,
      0.5
    ],
    "phases": {
      "prepara": 2.0,
      "aperti": 7.0,
      "chiudi": 8.0,
      "chiusi": 11.0
    },
    "head": {
      "fraction": 0.7,
      "min_drop_degrees": 8.0,
      "threshold_limits": [
        8,
        35
      ],
      "bowed_quantile": 0.75,
      "min_straight_samples": 15,
      "min_bowed_samples": 8,
      "phases": {
        "capo_prepara": 3.0,
        "capo_dritto": 7.0,
        "capo_china": 10.0,
        "capo_chino": 14.0
      }
    }
  },
  "evaluation": {
    "tolerance_seconds": 3.0
  },
  "demo": {
    "auto_seconds": 4,
    "auto_ratio": 0.5,
    "auto_min_samples": 15,
    "auto_max_tries": 3,
    "ear_open_min": 0.17,
    "open_quantile": 0.75,
    "keep_manual_ratio": 0.9,
    "calib_phases": {
      "prepara": 1,
      "aperti": 6,
      "chiudi": 7,
      "chiusi": 10
    }
  }
};
