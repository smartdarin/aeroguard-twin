# AeroGuard Twin

Round 2 Software-in-the-Loop prototype for an aero-acoustic digital twin that detects early combustion-instability signatures and demonstrates bounded closed-loop correction.

## Concept

AeroGuard Twin is an edge-AI safety layer for high-performance hydrogen propulsion systems. It processes pressure/acoustic telemetry, identifies resonance-mode growth, and gives operators a real-time view of instability risk before destructive combustion oscillations fully develop.

The prototype demonstrates:

- CFD-derived pressure-monitor data replay.
- Edge-style acoustic feature extraction using Goertzel/FFT-like spectral energy estimates.
- A trained tiny MLP model for instability-risk prediction.
- Dominant acoustic mode identification across L2, T1, and T2 bands.
- Explainable visual indicators showing which frequency band is driving the decision.
- A bounded `dO/F` micro-correction output for closed-loop suppression.
- A multi-page dashboard with overview, system view, CFD/AI model status, and operator console.

## Live Prototype

This project is designed to run as a static web app.

After deployment through GitHub Pages, the prototype URL will be:

```text
https://smartdarin.github.io/aeroguard-twin/
```

## How To Run Locally

Recommended local method:

1. Open this folder in VS Code.
2. Start the project with the Live Server extension.
3. Open the local URL, usually:

```text
http://127.0.0.1:5500/index.html
```

The app is static and uses only HTML, CSS, and JavaScript. No npm install is required for the dashboard.

Note: running through Live Server or GitHub Pages is recommended because the dashboard loads `aeroguard_edge_model.json` with `fetch()`.

## Demo Flow

1. Open the dashboard.
2. Go to `Operator Console`.
3. Click `Load CSV`.
4. Select either:

```text
stable.CSV
Unstable.CSV
telemetry_cfd_model_replay.csv
```

5. Click `Start`.
6. Move between `System View`, `CFD + AI Model`, and `Operator Console` to show the full safety loop.

The replay does not run before a CSV is loaded and `Start` is pressed.

## Dashboard Pages

- `Overview`: explains the end-to-end SIL architecture.
- `System View`: shows a 3D-style propulsion cutaway, injector, combustion chamber, nozzle, sensor, edge AI, and decision output.
- `CFD + AI Model`: summarizes the CFD traces, training windows, model type, and error metric.
- `Operator Console`: shows spectral waterfall, pressure waveform, AI risk, dominant mode, dO/F correction, and telemetry packet log.

## AI Model

The current model is a lightweight edge-AI model stored in:

```text
aeroguard_edge_model.json
```

Model type:

```text
tiny-mlp-regression
```

Training data:

- 4 CFD pressure-monitor `.out` traces.
- 47 pressure-window training samples.
- Weak labels derived from pressure amplitude, growth, slope, and spectral concentration.

Input features:

- Mean chamber pressure
- Acoustic RMS
- Peak-to-peak pressure variation
- Absolute pressure slope
- Growth rate
- Spectral concentration
- L2 acoustic energy
- T1 acoustic energy
- T2 acoustic energy

Outputs:

- Instability risk score from 0 to 1
- Dominant acoustic mode attribution
- Controller input for bounded `dO/F` correction

Training result from the current artifact:

```text
Risk MAE: 0.0296
Training windows: 47
Hidden neurons: 8
```

Important: `label_risk_percent`, `label_delta_of`, and `label_stability_margin` in CSV files are validation labels only. They do not directly drive the risk gauge, chamber color, or correction command. The displayed risk is computed by the trained model.

## Retraining

To retrain after adding or replacing CFD pressure-monitor `.out` files:

```powershell
node train_edge_model.js
```

This regenerates:

```text
aeroguard_edge_model.json
telemetry_cfd_model_replay.csv
```

## CSV Format

Expected replay columns:

```csv
pressure_mpa,mixture_of,injector_dp_mpa,frequency_hz,label_risk_percent,label_delta_of,label_stability_margin,sample_rate_ksa,growth_rate
```

The dashboard uses physical telemetry columns to synthesize the pressure/acoustic stream and then runs the edge model on extracted features. Label columns are retained only for validation and presentation traceability.

## Repository Files

```text
index.html                  Dashboard structure
styles.css                  Dashboard and 3D-style system view styling
app.js                      Telemetry replay, feature extraction, AI inference, visualization
train_edge_model.js         CFD training script for the tiny MLP model
aeroguard_edge_model.json   Trained edge-AI model artifact
stable.CSV                  Stable replay example
Unstable.CSV                Instability replay example
telemetry_cfd_model_replay.csv  CFD-derived validation replay
*.out                       CFD pressure-monitor traces
```

## Prototype Status

This is a Round 2 SIL prototype. It is suitable for demonstrating the digital architecture, AI inference workflow, and operator visualization. It is not a certified production engine controller and would require substantially more CFD cases, hot-fire validation, robustness testing, and safety certification before any operational use.
