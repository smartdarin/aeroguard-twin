const sampleRate = 48000;
const blockSize = 512;
const minFreq = 200;
const maxFreq = 5000;
const spectrumBins = 112;
const frameMs = 70;

const modes = [
  {
    key: "L2",
    name: "Longitudinal L2",
    fullName: "Longitudinal 2nd harmonic",
    freq: 1120,
    color: "#57d9d0",
  },
  {
    key: "T1",
    name: "Transverse T1",
    fullName: "First transverse mode",
    freq: 2320,
    color: "#f1b84d",
  },
  {
    key: "T2",
    name: "Transverse T2",
    fullName: "Second transverse mode",
    freq: 3820,
    color: "#ef665f",
  },
];

const scenarios = {
  nominal: {
    label: "Nominal broadband field",
    modeIndex: 0,
    target: () => 0.11,
    drive: 0,
  },
  onset: {
    label: "Pre-resonance acoustic growth",
    modeIndex: 0,
    target: (age) => Math.min(0.92, 0.12 + age * 0.05),
    drive: 0.08,
  },
  suppress: {
    label: "Closed-loop suppression demo",
    modeIndex: 1,
    target: (age) => 0.12 + 0.62 / (1 + Math.exp(-(age - 6) * 0.95)),
    drive: 0.03,
  },
  abort: {
    label: "Abort drill: destructive growth",
    modeIndex: 2,
    target: (age) => Math.min(1.1, 0.16 + age * 0.07),
    drive: 0.1,
  },
};

const els = {
  waterfall: document.getElementById("waterfallCanvas"),
  waveform: document.getElementById("waveformCanvas"),
  trend: document.getElementById("trendCanvas"),
  engine: document.getElementById("engineCanvas"),
  riskGauge: document.getElementById("riskGauge"),
  riskValue: document.getElementById("riskValue"),
  topRisk: document.getElementById("topRisk"),
  modePill: document.getElementById("modePill"),
  dominantMode: document.getElementById("dominantMode"),
  dominantText: document.getElementById("dominantText"),
  controlAction: document.getElementById("controlAction"),
  controlReason: document.getElementById("controlReason"),
  edgeModelName: document.getElementById("edgeModelName"),
  edgeModelMeta: document.getElementById("edgeModelMeta"),
  latency: document.getElementById("latency"),
  edgeState: document.getElementById("edgeState"),
  telemetryRate: document.getElementById("telemetryRate"),
  pressureReadout: document.getElementById("pressureReadout"),
  trimReadout: document.getElementById("trimReadout"),
  pressureMetric: document.getElementById("pressureMetric"),
  mixtureMetric: document.getElementById("mixtureMetric"),
  injectorMetric: document.getElementById("injectorMetric"),
  frequencyMetric: document.getElementById("frequencyMetric"),
  growthMetric: document.getElementById("growthMetric"),
  packetMetric: document.getElementById("packetMetric"),
  trimMetric: document.getElementById("trimMetric"),
  marginMetric: document.getElementById("marginMetric"),
  dataSource: document.getElementById("dataSource"),
  csvButton: document.getElementById("csvButton"),
  csvInput: document.getElementById("csvInput"),
  telemetryBody: document.getElementById("telemetryBody"),
  streamClock: document.getElementById("streamClock"),
  replayHold: document.getElementById("replayHold"),
  replayHoldValue: document.getElementById("replayHoldValue"),
  overviewRisk: document.getElementById("overviewRisk"),
  overviewMode: document.getElementById("overviewMode"),
  overviewAction: document.getElementById("overviewAction"),
  overviewModel: document.getElementById("overviewModel"),
  trainingFiles: document.getElementById("trainingFiles"),
  trainingWindows: document.getElementById("trainingWindows"),
  trainingMae: document.getElementById("trainingMae"),
  trainingHead: document.getElementById("trainingHead"),
  trainingModelName: document.getElementById("trainingModelName"),
  trainingModelMeta: document.getElementById("trainingModelMeta"),
  systemChamber: document.getElementById("systemChamber"),
  systemPressure: document.getElementById("systemPressure"),
  systemAction: document.getElementById("systemAction"),
  systemMode: document.getElementById("systemMode"),
  systemRisk: document.getElementById("systemRisk"),
  systemTrim: document.getElementById("systemTrim"),
  runToggle: document.getElementById("runToggle"),
  runIcon: document.getElementById("runIcon"),
  sensitivity: document.getElementById("sensitivity"),
  sensitivityValue: document.getElementById("sensitivityValue"),
  authority: document.getElementById("authority"),
  authorityValue: document.getElementById("authorityValue"),
  armedToggle: document.getElementById("armedToggle"),
  barL2: document.getElementById("barL2"),
  barT1: document.getElementById("barT1"),
  barT2: document.getElementById("barT2"),
};

const ctx = {
  waterfall: els.waterfall.getContext("2d"),
  waveform: els.waveform.getContext("2d"),
  trend: els.trend.getContext("2d"),
  engine: els.engine.getContext("2d"),
};

const state = {
  running: false,
  replayReady: false,
  scenario: "nominal",
  scenarioStartedAt: 0,
  time: 0,
  frame: 0,
  packets: 0,
  resonanceAmp: 0.1,
  controlTrim: 0,
  risk: 0.18,
  dominant: modes[0],
  previousModeEnergy: 0.18,
  previousModelRms: 0,
  edgeModel: null,
  externalFrame: null,
  replayRows: [],
  replayIndex: 0,
  replayHoldTicks: 0,
  replayFrame: null,
  replayAdvanced: false,
  replayPacket: 0,
  logRows: [],
  waveform: new Array(blockSize).fill(0),
  trend: [],
  heatRows: [],
  burstLevel: 0,
  burstMode: 0,
  nextBurstAt: 1.2,
  frequencyWalk: 0,
  telemetry: {
    pressure: 9.705,
    mixture: 5.92,
    injectorDp: 1.42,
    sampleRate: 48,
    margin: 92,
    sensorBias: 0,
  },
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function seededNoise() {
  return Math.random() - 0.5;
}

function randomWalk(current, target, noise, pull, min, max) {
  return clamp(current + (target - current) * pull + seededNoise() * noise, min, max);
}

function closestMode(frequencyHz) {
  if (!Number.isFinite(frequencyHz)) return modes[0];
  return modes.reduce((best, mode) => (
    Math.abs(mode.freq - frequencyHz) < Math.abs(best.freq - frequencyHz) ? mode : best
  ), modes[0]);
}

function nextReplayFrame() {
  state.replayAdvanced = false;
  if (!state.replayReady || !state.replayRows.length) return null;

  if (!state.replayFrame || state.replayHoldTicks <= 0) {
    const sourceFrame = state.replayRows[state.replayIndex % state.replayRows.length];
    state.replayIndex += 1;
    state.replayPacket += 1;
    state.replayHoldTicks = Number(els.replayHold.value);
    state.replayFrame = { ...sourceFrame, packet: state.replayPacket };
    state.replayAdvanced = true;
  } else {
    state.replayHoldTicks -= 1;
  }

  return state.replayFrame;
}

function resizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function setScenario(nextScenario) {
  state.scenario = nextScenario;
  state.scenarioStartedAt = state.time;
  state.heatRows = [];
  document.querySelectorAll("[data-scenario]").forEach((button) => {
    button.classList.toggle("active", button.dataset.scenario === nextScenario);
  });
}

function scenarioAge() {
  return state.time - state.scenarioStartedAt;
}

function estimateReplayDrive(frame) {
  if (!frame) return 0.1;

  const pressureLoad = Number.isFinite(frame.pressure) ? clamp((frame.pressure - 9.68) / 0.28, 0, 1) : 0;
  const injectorLoad = Number.isFinite(frame.injectorDp) ? clamp((frame.injectorDp - 1.39) / 0.30, 0, 1) : 0;
  const mixtureLoad = Number.isFinite(frame.mixture) ? clamp(Math.abs(frame.mixture - 5.92) / 0.13, 0, 1) : 0;
  const growthLoad = Number.isFinite(frame.growth) ? clamp(Math.max(0, frame.growth) / 0.22, 0, 1) : 0;
  const mode = closestMode(frame.frequencyHz);
  const modalLoad = mode.key === "T2" ? 0.12 : mode.key === "T1" ? 0.06 : 0;

  return clamp(
    0.08 +
      pressureLoad * 0.32 +
      injectorLoad * 0.3 +
      mixtureLoad * 0.18 +
      growthLoad * 0.28 +
      modalLoad,
    0.07,
    1.08,
  );
}

function advanceLiveProcess() {
  if (state.externalFrame) {
    const frame = state.externalFrame;
    const sourceMode = closestMode(frame.frequencyHz);
    state.burstMode = modes.findIndex((mode) => mode.key === sourceMode.key);
    state.burstLevel = clamp(estimateReplayDrive(frame) * 0.58, 0, 0.92);
    state.frequencyWalk = randomWalk(state.frequencyWalk, (frame.frequencyHz ?? sourceMode.freq) - sourceMode.freq, 8, 0.22, -95, 95);
    state.telemetry.pressure = Number.isFinite(frame.pressure) ? frame.pressure : state.telemetry.pressure;
    state.telemetry.mixture = Number.isFinite(frame.mixture) ? frame.mixture : state.telemetry.mixture;
    state.telemetry.injectorDp = Number.isFinite(frame.injectorDp) ? frame.injectorDp : state.telemetry.injectorDp;
    state.telemetry.sampleRate = Number.isFinite(frame.sampleRate) ? frame.sampleRate : state.telemetry.sampleRate;
    state.telemetry.sensorBias = randomWalk(state.telemetry.sensorBias, 0, 0.012, 0.08, -0.04, 0.04);
    return;
  }

  if (state.scenario === "nominal" && state.time >= state.nextBurstAt) {
    state.burstLevel = 0.35 + Math.random() * 0.55;
    state.burstMode = Math.floor(Math.random() * modes.length);
    state.nextBurstAt = state.time + 1.1 + Math.random() * 4.2;
  }

  state.burstLevel *= 0.82 + Math.random() * 0.08;
  if (state.burstLevel < 0.015) state.burstLevel = 0;

  state.frequencyWalk = clamp(state.frequencyWalk * 0.94 + seededNoise() * 9, -65, 65);
  state.telemetry.sensorBias = randomWalk(state.telemetry.sensorBias, 0, 0.018, 0.035, -0.08, 0.08);

  const scenarioLoad =
    state.scenario === "nominal" ? 0 :
    state.scenario === "onset" ? 0.06 :
    state.scenario === "suppress" ? 0.08 :
    0.14;

  state.telemetry.pressure = randomWalk(
    state.telemetry.pressure,
    9.68 + state.resonanceAmp * 0.28 + scenarioLoad + Math.abs(state.controlTrim) * 0.03,
    0.026,
    0.18,
    9.52,
    10.12,
  );
  state.telemetry.mixture = randomWalk(
    state.telemetry.mixture,
    5.92 + state.controlTrim + scenarioLoad * 0.25,
    0.012,
    0.14,
    5.68,
    6.08,
  );
  state.telemetry.injectorDp = randomWalk(
    state.telemetry.injectorDp,
    1.39 + state.risk * 0.13 + scenarioLoad * 0.4,
    0.019,
    0.16,
    1.22,
    1.78,
  );
  state.telemetry.sampleRate = randomWalk(state.telemetry.sampleRate, 48, 0.055, 0.08, 47.72, 48.28);
}

function generateSamples() {
  advanceLiveProcess();
  const samples = new Array(blockSize);
  const scenario = scenarios[state.scenario];
  const age = scenarioAge();
  const mode = state.externalFrame?.frequencyHz ? closestMode(state.externalFrame.frequencyHz) : modes[scenario.modeIndex];
  const authority = Number(els.authority.value) / 100;
  const armed = els.armedToggle.checked;
  const burst = state.externalFrame ? state.burstLevel : state.scenario === "nominal" ? state.burstLevel : 0;
  const correctionRelief = armed ? Math.abs(state.controlTrim) * (2.2 + authority * 2.1) : 0;
  const replayTarget =
    state.externalFrame
      ? estimateReplayDrive(state.externalFrame)
      : scenario.target(age) + scenario.drive;
  const target = clamp(replayTarget + burst * 0.15 - correctionRelief + seededNoise() * 0.018, 0.07, 1.08);

  state.resonanceAmp += (target - state.resonanceAmp) * 0.075;

  for (let i = 0; i < blockSize; i += 1) {
    const t = state.time + i / sampleRate;
    const broadband = (0.085 + burst * 0.035) * seededNoise() + 0.035 * seededNoise();
    const pumpTone = (0.045 + burst * 0.024) * Math.sin(2 * Math.PI * (185 + state.frequencyWalk * 0.12) * t);
    const modalField =
      state.scenario === "nominal"
        ? modes.reduce((sum, nominalMode, index) => {
          const phase = state.frame * (0.006 + index * 0.002) + index * 1.7;
          const burstHit = state.burstMode === index ? burst * 0.08 : burst * 0.018;
          const amp = state.resonanceAmp * (0.14 + index * 0.022) + burstHit + seededNoise() * 0.004;
          const driftedFreq = nominalMode.freq + state.frequencyWalk + seededNoise() * 12;
          return sum + amp * Math.sin(2 * Math.PI * driftedFreq * t + phase);
        }, 0)
        : state.resonanceAmp *
          Math.sin(2 * Math.PI * (mode.freq + state.frequencyWalk * 0.5) * t + 0.25 * seededNoise());
    const harmonic =
      state.scenario === "nominal"
        ? 0.018 * Math.sin(2 * Math.PI * mode.freq * 2 * t)
        : state.resonanceAmp * 0.28 * Math.sin(2 * Math.PI * mode.freq * 2 * t);
    const sideband =
      state.scenario === "nominal"
        ? 0.014 * Math.sin(2 * Math.PI * (mode.freq + 74) * t)
        : state.resonanceAmp * 0.18 * Math.sin(2 * Math.PI * (mode.freq + 74) * t);
    const valveDither = Math.abs(state.controlTrim) * 0.05 * Math.sin(2 * Math.PI * 640 * t);
    samples[i] = broadband + pumpTone + modalField + harmonic + sideband + valveDither;
  }

  state.waveform = samples;
  state.time += frameMs / 1000;
  state.packets += 1;
  return samples;
}

function goertzel(samples, frequency) {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const windowed = samples[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (samples.length - 1)));
    s0 = windowed + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }

  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return power / samples.length;
}

function computeSpectrum(samples) {
  const spectrum = [];
  for (let i = 0; i < spectrumBins; i += 1) {
    const frequency = minFreq + (i / (spectrumBins - 1)) * (maxFreq - minFreq);
    const energy = Math.log10(1 + goertzel(samples, frequency) * 12);
    spectrum.push({
      frequency,
      energy: clamp(energy, 0, 1),
    });
  }
  return spectrum;
}

function alignSpectrumWithDecision(spectrum, analysis) {
  const targetFrequency = Number.isFinite(state.externalFrame?.frequencyHz)
    ? state.externalFrame.frequencyHz
    : analysis.dominant.freq;
  const risk = clamp(analysis.risk, 0, 1);
  const sigma = risk > 0.72 ? 95 : risk > 0.42 ? 75 : 55;
  const primaryBoost = risk < 0.18 ? 0.08 + risk * 0.35 : 0.18 + risk * 0.95;
  const harmonicFrequency = targetFrequency * 2;
  const harmonicBoost = risk > 0.42 ? primaryBoost * 0.36 : primaryBoost * 0.14;

  return spectrum.map((item) => {
    const primaryDistance = (item.frequency - targetFrequency) / sigma;
    const primaryBand = Math.exp(-0.5 * primaryDistance * primaryDistance) * primaryBoost;
    const harmonicDistance = (item.frequency - harmonicFrequency) / (sigma * 1.25);
    const harmonicBand =
      harmonicFrequency <= maxFreq ? Math.exp(-0.5 * harmonicDistance * harmonicDistance) * harmonicBoost : 0;
    const backgroundLift = risk > 0.72 ? 0.08 : risk > 0.42 ? 0.045 : 0.015;

    return {
      ...item,
      energy: clamp(Math.max(item.energy, primaryBand, harmonicBand) + backgroundLift * seededNoise(), 0, 1),
    };
  });
}

function analyze(samples, spectrum) {
  const sensitivity = Number(els.sensitivity.value) / 100;
  const modeScores = modes.map((mode) => {
    const direct = Math.log10(1 + goertzel(samples, mode.freq) * 0.85);
    const harmonic = Math.log10(1 + goertzel(samples, mode.freq * 2) * 0.45);
    const sidebandA = Math.log10(1 + goertzel(samples, mode.freq + 74) * 0.55);
    const score = clamp(direct * 0.72 + harmonic * 0.16 + sidebandA * 0.12, 0, 1.35);
    return { ...mode, score };
  });

  const dominant = modeScores.reduce((best, mode) => (mode.score > best.score ? mode : best), modeScores[0]);
  const growth = dominant.score - state.previousModeEnergy;
  state.previousModeEnergy = dominant.score;

  const spectralConcentration = dominant.score / (0.18 + spectrum.reduce((sum, item) => sum + item.energy, 0) / spectrum.length);
  const rawRisk =
    Math.max(0, dominant.score - 0.2) * 1.05 +
    Math.max(0, state.resonanceAmp - 0.16) * 2.25 +
    Math.max(0, growth) * 1.9 +
    Math.max(0, spectralConcentration - 1.25) * 0.12 +
    (sensitivity - 0.55) * 0.42 +
    Math.abs(seededNoise()) * 0.035;

  const risk = clamp(rawRisk, 0.02, 0.99);
  state.risk += (risk - state.risk) * 0.38;
  state.dominant = dominant;

  return { risk: state.risk, growth, modeScores, dominant };
}

function extractEdgeModelFeatures(samples) {
  const meanPressure = Number.isFinite(state.externalFrame?.pressure)
    ? state.externalFrame.pressure
    : Number.isFinite(state.telemetry?.pressure)
      ? state.telemetry.pressure
      : samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const avgSignal = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const centered = samples.map((value) => value - avgSignal);
  const acousticRms = Math.sqrt(centered.reduce((sum, value) => sum + value * value, 0) / centered.length);
  const peakToPeak = Math.max(...samples) - Math.min(...samples);
  const absSlope =
    samples.slice(1).reduce((sum, value, index) => sum + Math.abs(value - samples[index]), 0) /
    Math.max(1, samples.length - 1);
  const growth = acousticRms - state.previousModelRms;
  state.previousModelRms = acousticRms;

  const trainedModeEnergies = modes.map((mode) => {
    const direct = Math.log10(1 + goertzel(centered, mode.freq));
    const harmonic = Math.log10(1 + goertzel(centered, mode.freq * 2) * 0.45);
    const sideband = Math.log10(1 + goertzel(centered, mode.freq + 75) * 0.55);
    return direct * 0.74 + harmonic * 0.16 + sideband * 0.1;
  });
  const maxModeEnergy = Math.max(...trainedModeEnergies);
  const averageModeEnergy =
    trainedModeEnergies.reduce((sum, value) => sum + value, 0) / Math.max(1, trainedModeEnergies.length);

  return {
    raw: {
      meanPressure,
      acousticRms,
      peakToPeak,
      absSlope,
      growth,
      concentration: maxModeEnergy / Math.max(averageModeEnergy, 1e-6),
      l2Energy: trainedModeEnergies[0],
      t1Energy: trainedModeEnergies[1],
      t2Energy: trainedModeEnergies[2],
    },
    trainedModeEnergies,
  };
}

function runEdgeModel(samples, fallbackAnalysis) {
  const model = state.edgeModel;
  if (!model?.featureKeys?.length || !model?.riskHead) return fallbackAnalysis;

  const extracted = extractEdgeModelFeatures(samples);
  const standardized = model.featureKeys.map((key) => {
    const meanValue = model.normalizer?.means?.[key] ?? 0;
    const stdValue = model.normalizer?.stds?.[key] || 1;
    return ((extracted.raw[key] ?? 0) - meanValue) / stdValue;
  });
  const modelRisk = predictEdgeRisk(model.riskHead, standardized);

  const modeScores = modes.map((mode, index) => {
    const energy = extracted.trainedModeEnergies[index];
    const gain = model.modeHead?.gains?.find((item) => item.key === mode.key);
    const trainedScore = gain ? (energy - gain.threshold) * gain.gain : energy;
    return {
      ...mode,
      score: clamp(modelRisk * 0.25 + trainedScore * 0.35 + energy * 0.55, 0.04, 1),
    };
  });
  const dominant = modeScores.reduce((best, mode) => (mode.score > best.score ? mode : best), modeScores[0]);

  state.risk += (modelRisk - state.risk) * 0.42;
  state.dominant = dominant;

  return {
    risk: state.risk,
    growth: extracted.raw.growth,
    modeScores,
    dominant,
    modelRisk,
  };
}

function predictEdgeRisk(riskHead, standardized) {
  if (riskHead.type === "tiny-mlp-regression") {
    const hidden = riskHead.inputWeights.map((weights, hiddenIndex) => {
      const bias = riskHead.hiddenBias?.[hiddenIndex] ?? 0;
      const activation = bias + weights.reduce((sum, weight, index) => sum + weight * (standardized[index] ?? 0), 0);
      return Math.tanh(activation);
    });
    const output =
      (riskHead.outputBias ?? 0) +
      hidden.reduce((sum, value, index) => sum + value * (riskHead.outputWeights?.[index] ?? 0), 0);
    return clamp(1 / (1 + Math.exp(-output)), 0.02, 0.99);
  }

  if (riskHead.weights?.length) {
    return clamp(
      riskHead.weights[0] + standardized.reduce((sum, value, index) => sum + value * (riskHead.weights[index + 1] ?? 0), 0),
      0.02,
      0.99,
    );
  }

  return state.risk;
}

function applyReplayAnalysis(analysis) {
  const frame = state.externalFrame;
  if (!frame) return analysis;

  const frequencyMode = Number.isFinite(frame.frequencyHz) ? closestMode(frame.frequencyHz) : analysis.dominant;
  const modeScores = analysis.modeScores.map((mode) => ({
    ...mode,
    score: mode.key === frequencyMode.key ? clamp(mode.score + 0.08, 0.04, 1) : mode.score,
  }));
  const dominant = modeScores.reduce((best, mode) => (mode.score > best.score ? mode : best), modeScores[0]);

  state.dominant = dominant;

  return {
    ...analysis,
    modeScores,
    dominant,
    labelRisk: frame.labelRisk,
    labelTrim: frame.labelTrim,
  };
}

function updateControl(analysis) {
  const authority = Number(els.authority.value) / 100;
  const armed = els.armedToggle.checked;
  const aborting = state.scenario === "abort";

  if (!armed || aborting) {
    state.controlTrim += (0 - state.controlTrim) * 0.08;
    return;
  }

  const targetTrim = analysis.risk > 0.45 ? -authority * clamp((analysis.risk - 0.38) * 3.0, 0, 1.08) : 0;
  state.controlTrim += (targetTrim - state.controlTrim) * 0.24;
}

function riskColor(risk) {
  if (risk > 0.72) return "#ef665f";
  if (risk > 0.46) return "#f1b84d";
  return "#63d98f";
}

function heatColor(value) {
  const v = clamp(value, 0, 1);
  const stops = [
    [8, 10, 9],
    [27, 60, 47],
    [45, 142, 124],
    [241, 184, 77],
    [239, 102, 95],
  ];
  const segment = Math.min(stops.length - 2, Math.floor(v * (stops.length - 1)));
  const local = v * (stops.length - 1) - segment;
  const a = stops[segment];
  const b = stops[segment + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * local);
  const g = Math.round(a[1] + (b[1] - a[1]) * local);
  const bl = Math.round(a[2] + (b[2] - a[2]) * local);
  return `rgb(${r}, ${g}, ${bl})`;
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const value = Number.parseInt(clean, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function roundedPath(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function drawEngineTwin({
  risk = state.risk,
  mode = state.dominant,
  pressure,
  displayFreq,
  trim = state.controlTrim,
  action = "IDLE",
} = {}) {
  const canvas = els.engine;
  if (!canvas) return;
  resizeCanvas(canvas);

  const context = ctx.engine;
  const { width, height } = canvas;
  const riskValue = clamp(risk, 0.02, 0.99);
  const color = riskColor(riskValue);
  const freq = Number.isFinite(displayFreq) ? displayFreq : (mode?.freq ?? modes[0].freq);
  const frequencyRatio = clamp((freq - minFreq) / (maxFreq - minFreq), 0, 1);
  const pulse = 0.5 + Math.sin(state.time * 5.5) * 0.5;
  const phase = state.time * 0.7;

  context.clearRect(0, 0, width, height);
  const bg = context.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, "#070a09");
  bg.addColorStop(0.48, "#101815");
  bg.addColorStop(1, "#050706");
  context.fillStyle = bg;
  context.fillRect(0, 0, width, height);

  const floorY = height * 0.78;
  context.save();
  context.strokeStyle = "rgba(87, 217, 208, 0.08)";
  context.lineWidth = Math.max(1, width / 900);
  for (let i = 0; i < 8; i += 1) {
    const y = floorY + i * height * 0.035;
    context.beginPath();
    context.moveTo(width * 0.08, y);
    context.lineTo(width * 0.92, y + i * height * 0.018);
    context.stroke();
  }
  for (let i = 0; i < 9; i += 1) {
    const x = width * (0.12 + i * 0.095);
    context.beginPath();
    context.moveTo(width * 0.5, floorY - height * 0.08);
    context.lineTo(x, height * 0.96);
    context.stroke();
  }
  context.restore();

  const chamberX = width * 0.19;
  const chamberW = width * 0.48;
  const chamberY = height * 0.47;
  const chamberH = height * 0.36;
  const chamberR = chamberH * 0.5;
  const innerX = chamberX + chamberH * 0.23;
  const innerW = chamberW - chamberH * 0.42;
  const innerY = chamberY - chamberH * 0.23;
  const innerH = chamberH * 0.46;
  const nozzleX = chamberX + chamberW - chamberH * 0.03;
  const nozzleEndX = width * 0.86;
  const injectorX = width * 0.055;
  const injectorW = width * 0.11;
  const injectorH = chamberH * 1.12;
  const injectorY = chamberY - injectorH * 0.5;

  context.save();
  context.shadowColor = "rgba(0, 0, 0, 0.7)";
  context.shadowBlur = height * 0.06;
  context.shadowOffsetY = height * 0.035;
  roundedPath(context, chamberX - chamberH * 0.12, chamberY - chamberH * 0.56, chamberW + chamberH * 0.23, chamberH * 1.12, chamberR);
  context.fillStyle = "rgba(0, 0, 0, 0.45)";
  context.fill();
  context.restore();

  const nozzleGradient = context.createLinearGradient(nozzleX, chamberY, nozzleEndX, chamberY);
  nozzleGradient.addColorStop(0, "rgba(25, 55, 47, 0.96)");
  nozzleGradient.addColorStop(0.5, "rgba(7, 13, 11, 0.98)");
  nozzleGradient.addColorStop(1, "rgba(1, 3, 2, 0.98)");
  context.save();
  context.beginPath();
  context.moveTo(nozzleX, chamberY - chamberH * 0.35);
  context.lineTo(nozzleEndX, chamberY - chamberH * 0.55);
  context.lineTo(nozzleEndX, chamberY + chamberH * 0.55);
  context.lineTo(nozzleX, chamberY + chamberH * 0.35);
  context.closePath();
  context.fillStyle = nozzleGradient;
  context.fill();
  context.strokeStyle = "rgba(87, 217, 208, 0.36)";
  context.lineWidth = Math.max(2, width / 520);
  context.stroke();
  context.shadowColor = "rgba(87, 217, 208, 0.18)";
  context.shadowBlur = height * 0.04;
  context.beginPath();
  context.ellipse(nozzleEndX - chamberH * 0.05, chamberY, chamberH * 0.08, chamberH * 0.55, 0, 0, Math.PI * 2);
  context.stroke();
  context.restore();

  context.save();
  context.shadowColor = rgba(color, 0.16 + riskValue * 0.2);
  context.shadowBlur = height * (0.04 + riskValue * 0.05);
  roundedPath(context, chamberX, chamberY - chamberH * 0.5, chamberW, chamberH, chamberR);
  const shellGradient = context.createLinearGradient(chamberX, chamberY - chamberH * 0.5, chamberX, chamberY + chamberH * 0.5);
  shellGradient.addColorStop(0, "rgba(185, 214, 197, 0.26)");
  shellGradient.addColorStop(0.16, "rgba(43, 65, 57, 0.86)");
  shellGradient.addColorStop(0.5, "rgba(8, 14, 11, 0.92)");
  shellGradient.addColorStop(0.84, "rgba(2, 4, 3, 0.98)");
  shellGradient.addColorStop(1, "rgba(110, 140, 126, 0.18)");
  context.fillStyle = shellGradient;
  context.fill();
  context.strokeStyle = rgba(color, 0.5);
  context.lineWidth = Math.max(2, width / 520);
  context.stroke();
  context.restore();

  context.save();
  roundedPath(context, innerX, innerY, innerW, innerH, innerH * 0.5);
  context.clip();
  const heatGradient = context.createLinearGradient(innerX, 0, innerX + innerW, 0);
  heatGradient.addColorStop(0, riskValue > 0.72 ? "rgba(239, 102, 95, 0.56)" : "rgba(87, 217, 208, 0.24)");
  heatGradient.addColorStop(0.33, riskValue > 0.46 ? "rgba(241, 184, 77, 0.62)" : "rgba(87, 217, 208, 0.38)");
  heatGradient.addColorStop(0.55, rgba(color, 0.74));
  heatGradient.addColorStop(0.78, riskValue > 0.72 ? "rgba(239, 102, 95, 0.38)" : "rgba(99, 217, 143, 0.38)");
  heatGradient.addColorStop(1, "rgba(22, 38, 28, 0.65)");
  context.fillStyle = heatGradient;
  context.fillRect(innerX, innerY, innerW, innerH);

  const hotspotX = innerX + innerW * frequencyRatio;
  const hotRadius = innerH * (0.85 + riskValue * 0.85);
  const hotspot = context.createRadialGradient(hotspotX, chamberY, innerH * 0.05, hotspotX, chamberY, hotRadius);
  hotspot.addColorStop(0, rgba(color, 0.92));
  hotspot.addColorStop(0.38, rgba(color, 0.42));
  hotspot.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = hotspot;
  context.fillRect(innerX, innerY - innerH, innerW, innerH * 3);

  context.globalAlpha = 0.28 + riskValue * 0.38;
  context.strokeStyle = riskValue > 0.72 ? "rgba(255, 236, 174, 0.62)" : rgba(color, 0.62);
  context.lineWidth = Math.max(2, width / 650);
  for (let ring = -2; ring <= 2; ring += 1) {
    const offset = ring * innerW * 0.075 + Math.sin(state.time * 3 + ring) * innerW * 0.006;
    context.beginPath();
    context.ellipse(hotspotX + offset, chamberY, innerH * (0.18 + riskValue * 0.22), innerH * 0.92, 0, 0, Math.PI * 2);
    context.stroke();
  }
  context.restore();

  context.save();
  roundedPath(context, chamberX + chamberH * 0.08, chamberY - chamberH * 0.43, chamberW - chamberH * 0.16, chamberH * 0.86, chamberR);
  context.strokeStyle = "rgba(255, 255, 255, 0.08)";
  context.lineWidth = Math.max(1, width / 900);
  context.stroke();
  for (let i = 0; i < 11; i += 1) {
    const x = chamberX + chamberW * (0.08 + i * 0.084);
    context.strokeStyle = i % 2 ? "rgba(255, 255, 255, 0.045)" : "rgba(87, 217, 208, 0.055)";
    context.beginPath();
    context.moveTo(x, chamberY - chamberH * 0.43);
    context.lineTo(x + Math.sin(i + phase) * width * 0.002, chamberY + chamberH * 0.43);
    context.stroke();
  }
  context.restore();

  context.save();
  context.strokeStyle = rgba(color, 0.5 + riskValue * 0.25);
  context.lineWidth = Math.max(2, width / 700);
  context.beginPath();
  for (let i = 0; i <= 120; i += 1) {
    const x = innerX + (innerW * i) / 120;
    const envelope = Math.sin((i / 120) * Math.PI);
    const y = chamberY + Math.sin(i * 0.42 + state.time * 8.5) * innerH * 0.28 * envelope * riskValue;
    if (i === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.stroke();
  context.restore();

  context.save();
  roundedPath(context, injectorX, injectorY, injectorW, injectorH, injectorH * 0.12);
  const injectorGradient = context.createLinearGradient(injectorX, injectorY, injectorX + injectorW, injectorY);
  injectorGradient.addColorStop(0, "rgba(6, 11, 9, 0.96)");
  injectorGradient.addColorStop(0.55, "rgba(19, 46, 42, 0.92)");
  injectorGradient.addColorStop(1, "rgba(2, 4, 3, 0.98)");
  context.fillStyle = injectorGradient;
  context.fill();
  context.strokeStyle = "rgba(87, 217, 208, 0.5)";
  context.lineWidth = Math.max(2, width / 620);
  context.stroke();
  context.beginPath();
  context.ellipse(injectorX + injectorW * 0.86, chamberY, injectorW * 0.13, injectorH * 0.44, 0, 0, Math.PI * 2);
  context.fillStyle = "rgba(0, 0, 0, 0.72)";
  context.fill();
  context.strokeStyle = "rgba(87, 217, 208, 0.35)";
  context.stroke();

  const holes = [
    [0.24, 0.28], [0.48, 0.28], [0.68, 0.28],
    [0.36, 0.5], [0.58, 0.5],
    [0.24, 0.72], [0.48, 0.72], [0.68, 0.72],
  ];
  holes.forEach(([hx, hy]) => {
    context.beginPath();
    context.arc(injectorX + injectorW * hx, injectorY + injectorH * hy, Math.max(4, width / 180), 0, Math.PI * 2);
    context.fillStyle = "rgba(87, 217, 208, 0.58)";
    context.fill();
  });
  context.restore();

  context.save();
  context.strokeStyle = "rgba(87, 217, 208, 0.48)";
  context.lineWidth = Math.max(2, width / 760);
  context.setLineDash([width * 0.01, width * 0.01]);
  context.beginPath();
  context.moveTo(injectorX + injectorW, chamberY);
  context.lineTo(chamberX, chamberY);
  context.stroke();
  context.restore();

  context.save();
  context.shadowColor = rgba(color, 0.26 + riskValue * 0.25);
  context.shadowBlur = height * 0.06;
  const plume = context.createRadialGradient(nozzleEndX + width * 0.03, chamberY, height * 0.02, nozzleEndX + width * 0.12, chamberY, height * 0.18);
  plume.addColorStop(0, rgba(color, 0.28 + riskValue * 0.28));
  plume.addColorStop(0.56, "rgba(87, 217, 208, 0.11)");
  plume.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = plume;
  context.beginPath();
  context.ellipse(nozzleEndX + width * 0.08, chamberY, width * 0.11, chamberH * 0.5, 0, 0, Math.PI * 2);
  context.fill();
  context.restore();

  const sensorX = chamberX + chamberW * 0.5;
  const sensorY = chamberY + chamberH * 0.72;
  context.save();
  context.strokeStyle = "rgba(87, 217, 208, 0.5)";
  context.lineWidth = Math.max(2, width / 720);
  context.beginPath();
  context.moveTo(sensorX, chamberY + chamberH * 0.5);
  context.lineTo(sensorX, sensorY - height * 0.035);
  context.stroke();
  context.beginPath();
  context.arc(sensorX, sensorY, Math.max(8, width / 120), 0, Math.PI * 2);
  context.fillStyle = "#070a09";
  context.fill();
  context.strokeStyle = "#57d9d0";
  context.stroke();
  context.restore();

  const fontScale = Math.max(1, width / 1100);
  context.save();
  context.fillStyle = "rgba(240, 245, 239, 0.82)";
  context.textAlign = "center";
  context.font = `800 ${Math.round(13 * fontScale)}px system-ui`;
  context.fillText("INJECTOR FACE", injectorX + injectorW * 0.5, injectorY + injectorH + height * 0.055);
  context.fillText("NOZZLE", (nozzleX + nozzleEndX) * 0.5, chamberY + chamberH * 0.06);
  context.fillText("PIEZO PRESSURE SENSOR", sensorX, sensorY + height * 0.075);

  context.fillStyle = "rgba(158, 170, 159, 0.9)";
  context.font = `850 ${Math.round(12 * fontScale)}px system-ui`;
  context.fillText("COMBUSTION CHAMBER CUTAWAY", chamberX + chamberW * 0.5, chamberY - chamberH * 0.08);
  context.fillStyle = "#f0f5ef";
  context.font = `900 ${Math.round(25 * fontScale)}px system-ui`;
  context.fillText(Number.isFinite(pressure) ? `Pch ${pressure.toFixed(3)} MPa` : "Pch --", chamberX + chamberW * 0.5, chamberY + chamberH * 0.08);

  context.textAlign = "left";
  context.fillStyle = rgba(color, 0.96);
  context.font = `900 ${Math.round(14 * fontScale)}px system-ui`;
  context.fillText(`${mode?.key ?? "--"} acoustic lobe`, hotspotX + width * 0.014, innerY - height * 0.03);
  context.fillStyle = "rgba(240, 245, 239, 0.86)";
  context.font = `800 ${Math.round(12 * fontScale)}px system-ui`;
  context.fillText(`${(freq / 1000).toFixed(3)} kHz | ${Math.round(riskValue * 100)}% risk | ${action}`, width * 0.045, height * 0.09);
  context.fillText(`dO/F ${trim.toFixed(3)}`, width * 0.045, height * 0.14);
  context.restore();
}

function drawGrid(context, width, height) {
  context.strokeStyle = "rgba(255,255,255,0.08)";
  context.lineWidth = 1;
  for (let i = 1; i < 5; i += 1) {
    const x = (width / 5) * i;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  for (let i = 1; i < 4; i += 1) {
    const y = (height / 4) * i;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
}

function drawWaterfall(spectrum) {
  const canvas = els.waterfall;
  const context = ctx.waterfall;
  resizeCanvas(canvas);
  const { width, height } = canvas;
  const rowHeight = Math.max(2, Math.floor(height / 150));
  const row = spectrum.map((item) => clamp(item.energy * 1.7, 0, 1));
  state.heatRows.unshift(row);
  const maxRows = Math.ceil(height / rowHeight);
  state.heatRows = state.heatRows.slice(0, maxRows);

  context.fillStyle = "#080a09";
  context.fillRect(0, 0, width, height);

  state.heatRows.forEach((values, rowIndex) => {
    const y = rowIndex * rowHeight;
    values.forEach((value, index) => {
      const x = (index / values.length) * width;
      const nextX = ((index + 1) / values.length) * width;
      context.fillStyle = heatColor(value);
      context.fillRect(x, y, Math.ceil(nextX - x) + 1, rowHeight);
    });
  });

  drawGrid(context, width, height);

  modes.forEach((mode) => {
    const x = ((mode.freq - minFreq) / (maxFreq - minFreq)) * width;
    context.strokeStyle = mode.color;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  });
}

function drawWaveform() {
  const canvas = els.waveform;
  const context = ctx.waveform;
  resizeCanvas(canvas);
  const { width, height } = canvas;

  context.fillStyle = "#080a09";
  context.fillRect(0, 0, width, height);
  drawGrid(context, width, height);

  context.strokeStyle = "#57d9d0";
  context.lineWidth = 2;
  context.beginPath();
  state.waveform.forEach((sample, index) => {
    const x = (index / (state.waveform.length - 1)) * width;
    const y = height * 0.5 - clamp(sample, -1.15, 1.15) * height * 0.34;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();

  context.strokeStyle = "rgba(241,184,77,0.9)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, height * 0.5);
  context.lineTo(width, height * 0.5);
  context.stroke();
}

function drawTrend() {
  const canvas = els.trend;
  const context = ctx.trend;
  resizeCanvas(canvas);
  const { width, height } = canvas;
  const history = state.trend.slice(-160);

  context.fillStyle = "#080a09";
  context.fillRect(0, 0, width, height);
  drawGrid(context, width, height);

  const drawLine = (selector, color, scale, offset = 0) => {
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.beginPath();
    history.forEach((point, index) => {
      const x = history.length <= 1 ? 0 : (index / (history.length - 1)) * width;
      const y = height - clamp(selector(point) * scale + offset, 0, 1) * height;
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.stroke();
  };

  drawLine((point) => point.risk, "#ef665f", 0.92, 0.04);
  drawLine((point) => Math.abs(point.trim), "#57d9d0", 1.6, 0.02);

  context.fillStyle = "rgba(240,245,239,0.72)";
  context.font = `${Math.max(11, Math.floor(width / 62))}px system-ui`;
  context.fillText("red: AI risk", 14, 22);
  context.fillText("cyan: dO/F correction magnitude", 14, 42);
}

function pushTelemetryLog(row) {
  if (state.externalFrame && !state.replayAdvanced) return;
  if (!state.externalFrame && state.frame % 4 !== 0) return;
  state.logRows.unshift(row);
  state.logRows = state.logRows.slice(0, 9);
  renderTelemetryLog();
}

function renderTelemetryLog() {
  els.telemetryBody.replaceChildren();
  state.logRows.forEach((row) => {
    const tr = document.createElement("tr");
    [
      row.packet,
      row.pressure,
      row.mixture,
      row.injector,
      row.frequency,
      row.risk,
      row.mode,
      row.action,
    ].forEach((value) => {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    });
    els.telemetryBody.appendChild(tr);
  });
}

function updateUI(analysis) {
  const riskPercent = Math.round(analysis.risk * 100);
  const riskDisplay = (analysis.risk * 100).toFixed(1);
  const color = riskColor(analysis.risk);
  const mode = analysis.dominant;
  const pressure = Number.isFinite(state.externalFrame?.pressure)
    ? state.externalFrame.pressure
    : state.telemetry.pressure + state.telemetry.sensorBias;
  const mixture = Number.isFinite(state.externalFrame?.mixture) ? state.externalFrame.mixture : state.telemetry.mixture;
  const injectorDeltaP = Number.isFinite(state.externalFrame?.injectorDp)
    ? state.externalFrame.injectorDp
    : state.telemetry.injectorDp;
  const displayFreq = Number.isFinite(state.externalFrame?.frequencyHz)
    ? state.externalFrame.frequencyHz
    : mode.freq + state.frequencyWalk + seededNoise() * 18;
  const pressureDelta = (state.waveform[state.waveform.length - 1] + state.telemetry.sensorBias) * 0.22;
  const latency = 1.7 + analysis.risk * 1.4 + Math.abs(state.controlTrim) * 1.2 + Math.abs(seededNoise()) * 0.35;
  const measuredRate = state.telemetry.sampleRate;
  state.telemetry.margin = randomWalk(
    state.telemetry.margin,
    (1 - analysis.risk) * 100 - Math.abs(state.controlTrim) * 18,
    2.8,
    0.16,
    0,
    99,
  );
  const stabilityMargin = state.telemetry.margin;

  els.riskGauge.style.setProperty("--risk", `${riskPercent}%`);
  els.riskGauge.style.setProperty("--risk-color", color);
  els.riskValue.textContent = riskDisplay;
  els.topRisk.textContent = `${riskDisplay}%`;
  els.topRisk.style.color = color;
  els.modePill.textContent = scenarios[state.scenario].label;
  els.dominantMode.textContent = `${mode.name} (${(mode.freq / 1000).toFixed(2)} kHz)`;
  els.latency.textContent = `${latency.toFixed(1)} ms`;
  const correcting = els.armedToggle.checked && Math.abs(state.controlTrim) > 0.035;
  els.edgeState.textContent = !els.armedToggle.checked ? "MONITOR" : correcting ? "CORRECT" : "ARMED";
  els.edgeState.style.color = !els.armedToggle.checked ? "#f1b84d" : correcting ? "#57d9d0" : "#63d98f";
  els.telemetryRate.textContent = `${measuredRate.toFixed(2)} kSa/s`;

  const riskState =
    analysis.risk > 0.72 ? "Critical growth signature detected." :
    analysis.risk > 0.46 ? "Pre-resonance signature is forming." :
    "No destructive growth signature detected.";

  els.dominantText.textContent = `${riskState} XAI attribution is concentrated around ${mode.fullName}.`;

  if (state.scenario === "abort") {
    els.controlAction.textContent = "Recommend engine shutdown path";
    els.controlReason.textContent = "Growth exceeds bounded correction authority in this drill.";
  } else if (!els.armedToggle.checked) {
    els.controlAction.textContent = "Human-in-the-loop monitor only";
    els.controlReason.textContent = "Closed-loop correction is disabled; dashboard keeps reporting risk.";
  } else if (analysis.risk > 0.45) {
    els.controlAction.textContent = `Apply dO/F ${state.controlTrim.toFixed(3)} micro-trim`;
    els.controlReason.textContent = "The edge model is injecting a bounded setpoint change to break phase coherence.";
  } else {
    els.controlAction.textContent = "Hold injector setpoints";
    els.controlReason.textContent = "Spectral energy remains inside nominal acoustic margin.";
  }

  const scores = analysis.modeScores;
  els.barL2.style.width = `${Math.round(clamp(scores[0].score, 0.04, 1) * 100)}%`;
  els.barT1.style.width = `${Math.round(clamp(scores[1].score, 0.04, 1) * 100)}%`;
  els.barT2.style.width = `${Math.round(clamp(scores[2].score, 0.04, 1) * 100)}%`;

  els.pressureReadout.textContent = `${pressureDelta >= 0 ? "+" : ""}${pressureDelta.toFixed(3)} MPa`;
  els.trimReadout.textContent = `dO/F ${state.controlTrim.toFixed(3)}`;
  els.trimMetric.textContent = `dO/F ${state.controlTrim.toFixed(3)}`;
  els.pressureMetric.textContent = `${pressure.toFixed(3)} MPa`;
  els.mixtureMetric.textContent = `${mixture.toFixed(3)} O/F`;
  els.injectorMetric.textContent = `${injectorDeltaP.toFixed(3)} MPa`;
  els.frequencyMetric.textContent = `${(displayFreq / 1000).toFixed(3)} kHz`;
  els.growthMetric.textContent = `${analysis.growth >= 0 ? "+" : ""}${(analysis.growth * 16).toFixed(3)}/s`;
  const packetLabel = String(state.externalFrame?.packet ?? state.packets).padStart(6, "0");
  els.packetMetric.textContent = packetLabel;
  els.marginMetric.textContent = `${Math.round(stabilityMargin)}%`;
  els.streamClock.textContent = `T+${state.time.toFixed(2)} s`;
  els.overviewRisk.textContent = `${riskDisplay}%`;
  els.overviewMode.textContent = `${mode.name}`;
  els.overviewAction.textContent = state.scenario === "abort" ? "ABORT" : Math.abs(state.controlTrim) > 0.035 ? "TRIM" : "HOLD";
  els.overviewModel.textContent = state.edgeModel ? "CFD-trained" : "Fallback";
  els.systemPressure.textContent = `Pch ${pressure.toFixed(3)} MPa`;
  els.systemRisk.textContent = `${riskDisplay}%`;
  els.systemTrim.textContent = `dO/F ${state.controlTrim.toFixed(3)}`;
  els.systemAction.textContent = state.scenario === "abort" ? "ABORT" : Math.abs(state.controlTrim) > 0.035 ? "TRIM" : "HOLD";
  els.systemMode.textContent = `${mode.key} mode at ${(displayFreq / 1000).toFixed(3)} kHz`;
  const chamberRiskClass =
    analysis.risk > 0.72 ? "risk-critical" :
    analysis.risk > 0.42 ? "risk-watch" :
    "risk-safe";
  els.systemChamber.classList.remove("risk-idle", "risk-safe", "risk-watch", "risk-critical");
  els.systemChamber.classList.add(chamberRiskClass);
  const chamberIntensity = clamp(analysis.risk, 0.18, 1);
  els.systemChamber.style.setProperty("--risk-opacity", chamberIntensity.toFixed(3));
  els.systemChamber.style.setProperty("--core-opacity", (0.62 + chamberIntensity * 0.34).toFixed(3));
  els.systemChamber.style.setProperty("--hotspot-alpha", (chamberIntensity * 0.58).toFixed(3));
  els.systemChamber.style.setProperty("--ring-alpha", (chamberIntensity * 0.58).toFixed(3));
  els.systemChamber.style.setProperty("--ring-opacity", (0.18 + chamberIntensity * 0.6).toFixed(3));
  els.systemChamber.style.setProperty("--mode-position", `${clamp((displayFreq / maxFreq) * 100, 16, 86).toFixed(1)}%`);
  drawEngineTwin({
    risk: analysis.risk,
    mode,
    pressure,
    displayFreq,
    trim: state.controlTrim,
    action: els.systemAction.textContent,
  });

  pushTelemetryLog({
    packet: packetLabel,
    pressure: pressure.toFixed(3),
    mixture: mixture.toFixed(3),
    injector: injectorDeltaP.toFixed(3),
    frequency: (displayFreq / 1000).toFixed(3),
    risk: `${riskDisplay}%`,
    mode: mode.key,
    action: state.scenario === "abort" ? "ABORT" : Math.abs(state.controlTrim) > 0.035 ? "TRIM" : "HOLD",
  });

  els.sensitivityValue.textContent = `${els.sensitivity.value}%`;
  els.authorityValue.textContent = `${els.authority.value}%`;
  els.replayHoldValue.textContent = `${((Number(els.replayHold.value) * frameMs) / 1000).toFixed(1)} s`;
}

function tick() {
  if (!state.running || !state.replayReady) return;
  state.frame += 1;
  state.externalFrame = nextReplayFrame();
  const samples = generateSamples();
  const spectrum = computeSpectrum(samples);
  const baseAnalysis = analyze(samples, spectrum);
  const trainedAnalysis = runEdgeModel(samples, baseAnalysis);
  const analysis = applyReplayAnalysis(trainedAnalysis);
  const displaySpectrum = alignSpectrumWithDecision(spectrum, analysis);
  updateControl(analysis);
  state.trend.push({ risk: analysis.risk, trim: state.controlTrim });
  if (state.trend.length > 220) state.trend.shift();
  drawWaterfall(displaySpectrum);
  drawWaveform();
  drawTrend();
  updateUI(analysis);
}

document.querySelectorAll("[data-scenario]").forEach((button) => {
  button.addEventListener("click", () => setScenario(button.dataset.scenario));
});

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function normalizeKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function readNumber(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== "") {
      const numeric = Number(String(value).replace(/%/g, ""));
      if (Number.isFinite(numeric)) return numeric;
    }
  }
  return undefined;
}

function parseTelemetryCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map(normalizeKey);
  const rows = [];

  lines.slice(1).forEach((line) => {
    const cells = parseCsvLine(line);
    const raw = {};
    headers.forEach((header, index) => {
      raw[header] = cells[index] ?? "";
    });

    const riskRaw = readNumber(raw, ["labelrisk", "labelriskpercent", "risk", "riskpercent", "riskpct", "instabilityrisk", "instabilityriskpercent"]);
    const freqHz = readNumber(raw, ["frequencyhz", "freqhz", "dominantfrequencyhz", "dominantfreqhz", "modefrequencyhz"]);
    const freqKHz = readNumber(raw, ["frequencykhz", "freqkhz", "dominantfrequencykhz", "dominantfreqkhz", "modefrequencykhz"]);

    const frame = {
      pressure: readNumber(raw, ["pressure", "pressurempa", "pch", "pchmpa", "chamberpressure", "chamberpressurempa"]),
      mixture: readNumber(raw, ["mixture", "mixtureof", "of", "ofratio", "mixtureratio"]),
      injectorDp: readNumber(raw, ["injectordp", "injectordpmpa", "injectordeltap", "injectordeltapmpa", "dpinjector"]),
      frequencyHz: Number.isFinite(freqHz) ? freqHz : Number.isFinite(freqKHz) ? freqKHz * 1000 : undefined,
      labelRisk: Number.isFinite(riskRaw) ? (riskRaw > 1 ? riskRaw / 100 : riskRaw) : undefined,
      labelTrim: readNumber(raw, ["labeltrim", "labeldeltaof", "trim", "dof", "deltaof", "oftrim", "valvetrim"]),
      labelMargin: readNumber(raw, ["labelmargin", "labelstabilitymargin", "margin", "stabilitymargin", "stabilitymarginpercent"]),
      sampleRate: readNumber(raw, ["samplerate", "samplerateksa", "telemetry", "telemetryksa", "ksamplerate"]),
      growth: readNumber(raw, ["growth", "growthrate", "growthrates"]),
    };

    if (
      Object.values(frame).some((value) => Number.isFinite(value))
    ) {
      rows.push(frame);
    }
  });

  return rows;
}

els.csvButton.addEventListener("click", () => {
  els.csvInput.click();
});

els.csvInput.addEventListener("change", async () => {
  const file = els.csvInput.files?.[0];
  if (!file) return;

  const text = await file.text();
  const rows = parseTelemetryCsv(text);
  if (!rows.length) {
    els.dataSource.textContent = "CSV rejected: no telemetry columns";
    return;
  }

  state.replayRows = rows;
  state.replayIndex = 0;
  state.replayHoldTicks = 0;
  state.replayFrame = null;
  state.replayPacket = 0;
  state.replayReady = true;
  state.running = false;
  state.logRows = [];
  state.heatRows = [];
  state.trend = [];
  state.packets = 0;
  state.time = 0;
  state.frame = 0;
  state.externalFrame = null;
  els.dataSource.textContent = `CSV replay: ${file.name}`;
  els.runToggle.disabled = false;
  els.runIcon.textContent = "Start";
  els.edgeState.textContent = "READY";
  els.edgeState.style.color = "#57d9d0";
  els.streamClock.textContent = "T+0.00 s";
  renderTelemetryLog();
  drawEngineTwin({ action: "READY" });
});

els.runToggle.addEventListener("click", () => {
  if (!state.replayReady) return;
  state.running = !state.running;
  els.runIcon.textContent = state.running ? "Pause" : "Start";
});

els.sensitivity.addEventListener("input", () => {
  els.sensitivityValue.textContent = `${els.sensitivity.value}%`;
});

els.authority.addEventListener("input", () => {
  els.authorityValue.textContent = `${els.authority.value}%`;
});

els.replayHold.addEventListener("input", () => {
  els.replayHoldValue.textContent = `${((Number(els.replayHold.value) * frameMs) / 1000).toFixed(1)} s`;
});

function setView(viewName) {
  document.querySelectorAll(".view-page").forEach((page) => {
    page.classList.toggle("active", page.id === `view-${viewName}`);
  });
  document.querySelectorAll("[data-view-target]").forEach((button) => {
    button.classList.toggle("active", button.dataset.viewTarget === viewName);
  });

  if (viewName === "console") {
    requestAnimationFrame(() => {
      drawWaterfall(computeSpectrum(state.waveform));
      drawWaveform();
      drawTrend();
    });
  } else if (viewName === "system") {
    requestAnimationFrame(() => drawEngineTwin());
  }
}

document.querySelectorAll("[data-view-target]").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.viewTarget));
});

async function loadTrainedEdgeModel() {
  try {
    const response = await fetch("aeroguard_edge_model.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.edgeModel = await response.json();
    const training = state.edgeModel.training;
    els.edgeModelName.textContent = state.edgeModel.name || "CFD-trained edge model";
    const modelKind = state.edgeModel.riskHead?.type === "tiny-mlp-regression" ? "Tiny MLP" : "Edge model";
    els.edgeModelMeta.textContent = `${modelKind}. ${training?.windowCount ?? "?"} CFD windows from ${
      training?.sourceFiles?.length ?? 4
    } traces. Risk MAE ${(training?.riskMae ?? 0).toFixed(3)}.`;
    els.trainingModelName.textContent = state.edgeModel.name || "AeroGuard CFD Edge Model";
    els.trainingModelMeta.textContent = `Loaded ${training?.sourceFiles?.length ?? 4} CFD traces and ${
      training?.windowCount ?? "?"
    } pressure windows from aeroguard_edge_model.json.`;
    els.trainingFiles.textContent = String(training?.sourceFiles?.length ?? 4);
    els.trainingWindows.textContent = String(training?.windowCount ?? "?");
    els.trainingMae.textContent = (training?.riskMae ?? 0).toFixed(3);
    els.trainingHead.textContent =
      state.edgeModel.riskHead?.type === "tiny-mlp-regression" ? "Tiny MLP + spectral mode" : "Risk + mode";
  } catch (error) {
    state.edgeModel = null;
    els.edgeModelName.textContent = "Heuristic fallback";
    els.edgeModelMeta.textContent = "Run through Live Server/localhost so the trained JSON model can be loaded.";
    els.trainingModelName.textContent = "Model not loaded";
    els.trainingModelMeta.textContent = "Run through localhost or Live Server to fetch aeroguard_edge_model.json.";
  }
}

window.addEventListener("resize", () => {
  drawWaterfall(computeSpectrum(state.waveform));
  drawWaveform();
  drawTrend();
  drawEngineTwin();
});

setScenario("nominal");
loadTrainedEdgeModel();
requestAnimationFrame(() => drawEngineTwin());
setInterval(tick, frameMs);
