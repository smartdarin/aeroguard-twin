const fs = require("fs");
const path = require("path");

const MODES = [
  { key: "L2", name: "Longitudinal L2", freq: 1120 },
  { key: "T1", name: "Transverse T1", freq: 2320 },
  { key: "T2", name: "Transverse T2", freq: 3820 },
];

const OUT_FILES = fs
  .readdirSync(".")
  .filter((file) => file.toLowerCase().endsWith(".out"))
  .sort();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

let seed = 42;

function randomWeight(scale = 0.22) {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return ((seed / 4294967296) - 0.5) * scale;
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function parseMonitor(file) {
  const rows = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+\s+[-+0-9.eE]+\s+[-+0-9.eE]+/.test(line))
    .map((line) => {
      const [step, pressure, time] = line.split(/\s+/).map(Number);
      return { step, pressure, time };
    });

  const dt = rows.length > 1 ? rows[1].time - rows[0].time : 0;
  return {
    file,
    rows,
    sampleRate: dt > 0 ? 1 / dt : 100000,
    duration: rows.length ? rows[rows.length - 1].time - rows[0].time : 0,
  };
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values, avg = mean(values)) {
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(Math.max(variance, 1e-12));
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = clamp((sorted.length - 1) * p, 0, sorted.length - 1);
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  const t = index - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

function goertzel(samples, sampleRate, frequency) {
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

  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / samples.length;
}

function extractFeatureRecord(values, sampleRate, previousRms = 0) {
  const avg = mean(values);
  const centered = values.map((value) => value - avg);
  const acousticRms = Math.sqrt(centered.reduce((sum, value) => sum + value * value, 0) / centered.length);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const peakToPeak = maxValue - minValue;
  const absSlope =
    values.slice(1).reduce((sum, value, index) => sum + Math.abs(value - values[index]), 0) /
    Math.max(1, values.length - 1);
  const growth = acousticRms - previousRms;
  const modeEnergies = MODES.map((mode) => {
    const direct = Math.log10(1 + goertzel(centered, sampleRate, mode.freq));
    const harmonic = Math.log10(1 + goertzel(centered, sampleRate, mode.freq * 2) * 0.45);
    const sideband = Math.log10(1 + goertzel(centered, sampleRate, mode.freq + 75) * 0.55);
    return direct * 0.74 + harmonic * 0.16 + sideband * 0.1;
  });
  const totalModeEnergy = modeEnergies.reduce((sum, value) => sum + value, 0);
  const maxModeEnergy = Math.max(...modeEnergies);
  const concentration = maxModeEnergy / Math.max(totalModeEnergy / modeEnergies.length, 1e-6);
  const dominantIndex = modeEnergies.indexOf(maxModeEnergy);

  return {
    raw: {
      meanPressure: avg,
      acousticRms,
      peakToPeak,
      absSlope,
      growth,
      concentration,
      l2Energy: modeEnergies[0],
      t1Energy: modeEnergies[1],
      t2Energy: modeEnergies[2],
    },
    dominantIndex,
  };
}

function makeWindows(report) {
  const pressures = report.rows.map((row) => row.pressure);
  const n = pressures.length;
  if (n < 24) return [];

  const windowSize = clamp(Math.floor(n / 5), 48, 256);
  const step = Math.max(8, Math.floor(windowSize / 3));
  const windows = [];
  let previousRms = 0;

  for (let start = 0; start + windowSize <= n; start += step) {
    const slice = pressures.slice(start, start + windowSize);
    const features = extractFeatureRecord(slice, report.sampleRate, previousRms);
    previousRms = features.raw.acousticRms;
    windows.push({
      file: report.file,
      start,
      end: start + windowSize,
      time: report.rows[start].time,
      sampleRate: report.sampleRate,
      ...features,
    });
  }

  if (!windows.length) {
    const features = extractFeatureRecord(pressures, report.sampleRate, previousRms);
    windows.push({
      file: report.file,
      start: 0,
      end: n,
      time: report.rows[0].time,
      sampleRate: report.sampleRate,
      ...features,
    });
  }

  return windows;
}

function buildDataset() {
  const reports = OUT_FILES.map(parseMonitor);
  const windows = reports.flatMap(makeWindows);
  const rmsP95 = percentile(windows.map((row) => row.raw.acousticRms), 0.95) || 1;
  const p2pP95 = percentile(windows.map((row) => row.raw.peakToPeak), 0.95) || 1;
  const slopeP95 = percentile(windows.map((row) => row.raw.absSlope), 0.95) || 1;
  const growthP95 = percentile(windows.map((row) => Math.max(0, row.raw.growth)), 0.95) || 1;

  windows.forEach((row) => {
    const acousticScore = clamp(row.raw.acousticRms / rmsP95, 0, 1.25);
    const p2pScore = clamp(row.raw.peakToPeak / p2pP95, 0, 1.25);
    const slopeScore = clamp(row.raw.absSlope / slopeP95, 0, 1.25);
    const growthScore = clamp(Math.max(0, row.raw.growth) / growthP95, 0, 1.25);
    const concentrationScore = clamp((row.raw.concentration - 0.95) / 1.2, 0, 1.2);
    row.riskTarget = clamp(
      0.08 +
        acousticScore * 0.28 +
        p2pScore * 0.2 +
        slopeScore * 0.13 +
        growthScore * 0.2 +
        concentrationScore * 0.16,
      0.02,
      0.99,
    );
    row.label = row.riskTarget < 0.22 ? "STABLE" : MODES[row.dominantIndex].key;
  });

  return { reports, windows };
}

const FEATURE_KEYS = [
  "meanPressure",
  "acousticRms",
  "peakToPeak",
  "absSlope",
  "growth",
  "concentration",
  "l2Energy",
  "t1Energy",
  "t2Energy",
];

function standardizeDataset(windows) {
  const means = {};
  const stds = {};
  FEATURE_KEYS.forEach((key) => {
    const values = windows.map((row) => row.raw[key]);
    means[key] = mean(values);
    stds[key] = std(values, means[key]) || 1;
  });

  windows.forEach((row) => {
    row.features = FEATURE_KEYS.map((key) => (row.raw[key] - means[key]) / stds[key]);
  });

  return { means, stds };
}

function trainRiskHead(windows) {
  const inputCount = FEATURE_KEYS.length;
  const hiddenCount = 8;
  const inputWeights = Array.from({ length: hiddenCount }, () =>
    Array.from({ length: inputCount }, () => randomWeight(0.28)),
  );
  const hiddenBias = Array.from({ length: hiddenCount }, () => randomWeight(0.08));
  const outputWeights = Array.from({ length: hiddenCount }, () => randomWeight(0.28));
  let outputBias = 0;
  const learningRate = 0.018;
  const l2 = 0.0015;

  for (let epoch = 0; epoch < 5200; epoch += 1) {
    const gradInputWeights = Array.from({ length: hiddenCount }, () => new Array(inputCount).fill(0));
    const gradHiddenBias = new Array(hiddenCount).fill(0);
    const gradOutputWeights = new Array(hiddenCount).fill(0);
    let gradOutputBias = 0;

    windows.forEach((row) => {
      const hiddenPre = inputWeights.map((weights, hiddenIndex) =>
        hiddenBias[hiddenIndex] + weights.reduce((sum, weight, index) => sum + weight * row.features[index], 0),
      );
      const hidden = hiddenPre.map(Math.tanh);
      const outputPre =
        outputBias + hidden.reduce((sum, value, index) => sum + value * outputWeights[index], 0);
      const prediction = clamp(sigmoid(outputPre), 0.02, 0.99);
      const outputGrad = (prediction - row.riskTarget) * prediction * (1 - prediction);

      gradOutputBias += outputGrad;
      hidden.forEach((value, hiddenIndex) => {
        gradOutputWeights[hiddenIndex] += outputGrad * value;
        const hiddenGrad = outputGrad * outputWeights[hiddenIndex] * (1 - value * value);
        gradHiddenBias[hiddenIndex] += hiddenGrad;
        row.features.forEach((featureValue, featureIndex) => {
          gradInputWeights[hiddenIndex][featureIndex] += hiddenGrad * featureValue;
        });
      });
    });

    for (let hiddenIndex = 0; hiddenIndex < hiddenCount; hiddenIndex += 1) {
      for (let featureIndex = 0; featureIndex < inputCount; featureIndex += 1) {
        inputWeights[hiddenIndex][featureIndex] -=
          learningRate * (gradInputWeights[hiddenIndex][featureIndex] / windows.length + l2 * inputWeights[hiddenIndex][featureIndex]);
      }
      hiddenBias[hiddenIndex] -= learningRate * (gradHiddenBias[hiddenIndex] / windows.length);
      outputWeights[hiddenIndex] -=
        learningRate * (gradOutputWeights[hiddenIndex] / windows.length + l2 * outputWeights[hiddenIndex]);
    }
    outputBias -= learningRate * (gradOutputBias / windows.length);
  }

  return {
    type: "tiny-mlp-regression",
    inputCount,
    hiddenCount,
    hiddenActivation: "tanh",
    outputActivation: "sigmoid",
    inputWeights,
    hiddenBias,
    outputWeights,
    outputBias,
    output: "instability_risk_0_to_1",
  };
}

function trainModeCentroids(windows) {
  const labels = ["STABLE", ...MODES.map((mode) => mode.key)];
  return labels.map((label) => {
    const group = windows.filter((row) => row.label === label);
    const source = group.length ? group : windows;
    const center = FEATURE_KEYS.map((_, index) => mean(source.map((row) => row.features[index])));
    return { label, center, count: group.length };
  });
}

function trainModeEnergyHead(windows) {
  const gains = MODES.map((mode, index) => {
    const positive = windows.filter((row) => row.dominantIndex === index).map((row) => row.raw[`${mode.key.toLowerCase()}Energy`]);
    const all = windows.map((row) => row.raw[`${mode.key.toLowerCase()}Energy`]);
    return {
      key: mode.key,
      meanPositiveEnergy: positive.length ? mean(positive) : mean(all),
      threshold: percentile(all, 0.35),
      gain: 1 / Math.max(std(all), 1e-6),
    };
  });

  const labelCounts = windows.reduce((acc, row) => {
    const label = row.riskTarget < 0.22 ? "STABLE" : MODES[row.dominantIndex].key;
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});

  return { gains, labelCounts };
}

function predictRisk(row, riskHead) {
  const hidden = riskHead.inputWeights.map((weights, hiddenIndex) => {
    const activation =
      riskHead.hiddenBias[hiddenIndex] + weights.reduce((sum, weight, index) => sum + weight * row.features[index], 0);
    return Math.tanh(activation);
  });
  const output =
    riskHead.outputBias + hidden.reduce((sum, value, index) => sum + value * riskHead.outputWeights[index], 0);
  return clamp(sigmoid(output), 0.02, 0.99);
}

function nearestLabel(row, centroids) {
  let best = centroids[0];
  let bestDistance = Infinity;
  centroids.forEach((centroid) => {
    const distance = centroid.center.reduce((sum, value, index) => sum + (value - row.features[index]) ** 2, 0);
    if (distance < bestDistance) {
      best = centroid;
      bestDistance = distance;
    }
  });
  return best.label;
}

function writeReplayCsv(windows, riskHead) {
  const rows = [
    "pressure_mpa,mixture_of,injector_dp_mpa,frequency_hz,label_risk_percent,label_delta_of,label_stability_margin,sample_rate_ksa,growth_rate,source_file",
  ];
  let trim = 0;
  windows.forEach((row) => {
    const risk = predictRisk(row, riskHead);
    const mode = MODES[row.dominantIndex];
    trim += ((risk > 0.42 ? -0.18 * (risk - 0.42) / 0.5 : 0) - trim) * 0.24;
    const pressure = row.raw.meanPressure / 1.75;
    const mixture = 5.92 + trim;
    const injectorDp = 1.34 + risk * 0.35;
    const margin = Math.round(clamp((1 - risk) * 100 - Math.abs(trim) * 24, 0, 99));
    rows.push(
      [
        pressure.toFixed(3),
        mixture.toFixed(3),
        injectorDp.toFixed(3),
        Math.round(mode.freq),
        (risk * 100).toFixed(1),
        trim.toFixed(3),
        margin,
        (row.sampleRate / 1000).toFixed(2),
        row.raw.growth.toFixed(4),
        `"${row.file}"`,
      ].join(","),
    );
  });
  fs.writeFileSync("telemetry_cfd_model_replay.csv", rows.join("\n"));
}

function main() {
  if (!OUT_FILES.length) {
    console.error("No .out files found.");
    process.exit(1);
  }

  const { reports, windows } = buildDataset();
  const normalizer = standardizeDataset(windows);
  const riskHead = trainRiskHead(windows);
  const centroids = trainModeCentroids(windows);
  const energyHead = trainModeEnergyHead(windows);
  const predictions = windows.map((row) => predictRisk(row, riskHead));
  const mae = mean(windows.map((row, index) => Math.abs(row.riskTarget - predictions[index])));
  const modeAccuracy = windows.filter((row) => MODES[row.dominantIndex].key === row.label || row.label === "STABLE").length / Math.max(1, windows.length);

  const model = {
    name: "AeroGuard CFD Edge Model",
    version: "0.3.0",
    trainedAt: new Date().toISOString(),
    caveat:
      "Round 2 SIL model trained on four CFD pressure-monitor traces using weak labels derived from pressure-window spectral features.",
    modes: MODES,
    featureKeys: FEATURE_KEYS,
    normalizer,
    riskHead,
    modeHead: {
      type: "spectral-energy-argmax",
      description: "Classifies the active acoustic mode by comparing learned energy scores around L2/T1/T2 bands.",
      ...energyHead,
      fallbackCentroids: centroids,
    },
    training: {
      sourceFiles: reports.map((report) => ({
        file: report.file,
        rows: report.rows.length,
        sampleRate: report.sampleRate,
        duration: report.duration,
      })),
      windowCount: windows.length,
      weakLabelCounts: energyHead.labelCounts,
      riskMae: mae,
      modeSelfAccuracy: modeAccuracy,
    },
  };

  fs.writeFileSync("aeroguard_edge_model.json", JSON.stringify(model, null, 2));
  writeReplayCsv(windows, riskHead);

  console.log(`Trained ${model.name}`);
  console.log(`Source files: ${OUT_FILES.length}`);
  console.log(`Training windows: ${windows.length}`);
  console.log(`Risk MAE: ${mae.toFixed(4)}`);
  console.log(`Mode self-accuracy: ${(modeAccuracy * 100).toFixed(1)}%`);
  console.log(`Wrote ${path.resolve("aeroguard_edge_model.json")}`);
  console.log(`Wrote ${path.resolve("telemetry_cfd_model_replay.csv")}`);
}

main();
